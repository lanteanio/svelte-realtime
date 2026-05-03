# Changelog

All notable changes to `svelte-realtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0-next.3] - 2026-05-03

### Fixed

- **`live.metrics()` documentation now matches a working integration.** Backport of the `0.4.23` fix from `main`: the README's "Prometheus metrics" example imported a non-existent `createMetricsRegistry` from `svelte-adapter-uws-extensions/prometheus`, and the `server.d.ts` JSDoc example imported a non-existent `createRegistry`. The real export is `createMetrics`, and its registry methods take positional args (`counter(name, help, labelNames)`) where `live.metrics()` calls them with options-object form (`counter({ name, help, labelNames })`). The README now shows a six-line adapter that bridges the two and is paired with `metrics.handler` for the `/metrics` endpoint. JSDoc and type declarations updated to match.

### Added

- **`MetricsRegistry` interface in `server.d.ts`.** Backport of `0.4.23`. TypeScript users now get autocomplete and structural validation on the registry shape passed to `live.metrics()`, replacing the previous `registry: any` signature.
- **Integration test exercising the real extensions registry.** Backport of `0.4.23`. `test/server.test.js` now imports `createMetrics` from `svelte-adapter-uws-extensions/prometheus` and runs the documented adapter shim against it, asserting that RPC counters, the duration histogram, the error counter, the stream subscription gauge, and the cron counter all flow through to the registry's serialized output. The merge bumped the `svelte-adapter-uws-extensions` devDependency from `^0.4.2` (as pinned on `main`) to `^0.5.0-next.3` so it tracks the rest of the dev-line ecosystem.

## [0.5.0-next.2] - 2026-05-03

### Internal

- **`shared/` directory for cross-cutting helpers.** Mirrors the `svelte-adapter-uws-extensions/shared/` layout. New `shared/assert.js` is the single source of truth for the `realtime/`-prefixed `assert` / `getAssertionCounters` / `_resetAssertCounters` API exported from both `server` and `client`; the server wires its Prometheus counter via `wireAssertionMetrics(...)` from the metrics-init site. New `shared/merge.js` exports `mergeKeyField(merge, defaultKey)` and `rebuildIndex(value, index, merge, defaultKey)` so the `(merge === 'presence' || merge === 'cursor') ? 'key' : key` literal stops appearing in four places and the index-rebuild logic has one home. Tests, public API surface, and runtime behavior unchanged; the package's `files` array now includes `shared`.

- **`_executeSingleRpc` split into a stream / non-stream pair.** The 280-line monolith now hands the stream branch off to a module-level `_executeStreamRpc(ws, platform, fn, ctx, args, msg, subscribedRef)` helper. The catch-block rollback path now reads the subscribed-topic out of a `subscribedRef` container that the helper writes into on successful subscribe, so a throw mid-load still rolls back the registration. The non-stream branch keeps its original shape inline.

- **`vite.js` export-detection compressed.** The five wrappers whose client stubs and registry entries are identical (`live` / `live.validated` / `live.lock` / `live.idempotent` / `live.rateLimit`) now drive a single `for (const re of [...])` loop in both `_buildTopicsRegistry` and the SSR registry generator, replacing five copies of the same 8-line `RE.lastIndex = 0; while ((match = RE.exec(source))...)` block in each pass. Roughly 80 lines deleted; behavior unchanged.

- **`_topicInvalidationWatch` publish path now skips the regex engine on the common case.** Each pattern's compiled entry now carries its literal prefix and a `prefixOnly` flag (true for `prefix*` shapes). The publish hot path fast-fails with `topic.startsWith(entry.prefix)` before invoking `regex.test`, and skips the regex entirely when the pattern is `prefix*` and the topic has at least one character beyond the prefix. With N registered patterns and a high publish rate this turns N regex.test calls per publish into N startsWith calls plus regex.test only for the rare patterns that actually match the prefix.

- **`process.env.NODE_ENV !== 'production'` checks consolidated.** Sixteen inline `typeof process !== 'undefined' && process.env(?.)?.NODE_ENV !== 'production'` checks across `server.js` now reference the existing `_IS_DEV` constant. Minifier-friendly and single-source.

- **Dev-mode hoist in `_executeBatch`.** The lazy-resolve await is now called once at the top of a batch instead of once per entry; with 50-entry batches this drops 49 redundant microtask awaits.

- **Stale JSDoc cleanup.** An orphaned JSDoc block that had drifted onto `_trackStreamSub` was removed; the misplaced `close()` JSDoc that was sitting above `enableSignals` was reattached to the actual `close()` definition.

### Removed

- **Dead `pipe.filter().transformEvent` field.** `pipe.filter()` returned `{ transformInit, transformEvent }` but `pipe()` only ever consumed `transformInit`, so the `transformEvent` field had no effect at runtime. The README at the access-control section also incorrectly suggested `pipe.filter()` for per-event filtering. The dead field is removed from `server.js` and `server.d.ts` (`PipeTransform` no longer declares `transformEvent`); the README pointer now correctly directs per-event projection to the `transform` option on `live.stream({ transform })`. The pipe table at "Server transforms" was already correct (filter / sort / limit / join are all "Initial data only").

## [0.5.0-next.1] - 2026-05-03

### Fixed

- **Rooms now SSR-render correctly.** The Vite plugin's `_generateSsrStubs` collected stream-like exports from `[STREAM_EXPORT_RE, CHANNEL_EXPORT_RE, DERIVED_EXPORT_RE, AGGREGATE_EXPORT_RE]` but had no case for `ROOM_EXPORT_RE`, so SSR fell through to `export * from <serverPath>` which re-exported the SERVER-side `live.room()` namespace (with `__dataStream`, `__presenceStream` etc.) instead of the CLIENT-shaped namespace (with `data: factory(...)`, `presence: factory(...)`, etc.). Pages that rendered `board.data(boardId)` during SvelteKit SSR crashed with `TypeError: board.data is not a function` and returned 500. The SSR generator now emits a per-room namespace stub: `data` / `presence` / `cursors` are factory-shaped readables (returning `readable(undefined)` with `.hydrate()`) and actions are no-op `() => Promise.resolve(undefined)` so they don't break post-hydration handler wiring.

- **Derived / effect / aggregate watchers now fire on the batched fast path.** `_wrapPlatformPublish` only wrapped `platform.publish`; it left `platform.publishBatched` untouched. Since `ctx.publish` falls through to `platform.publishBatched` when no per-topic coalesce or transform is registered (the default with the uWS adapter), source-topic publishes from any RPC handler that took the batched path failed to trigger derived recomputes / effects / aggregate updates in production. Vitest never caught this because `mockPlatform()` has no `publishBatched`, forcing the unbatched code path. The wrap now installs on both methods, iterating each batch entry and firing watchers per topic.

- **`_activateDerived` now wraps the prototype platform, not the per-connection clone.** The svelte-adapter-uws handler exposes per-connection platforms as `Object.create(basePlatform)`. `_activateDerived(ctx.platform)` was wrapping the per-connection wsPlatform's own `publish`, so every other connection's inherited lookup walked the prototype chain to the un-wrapped base and bypassed the wrap entirely. The activator now resolves to the prototype when the prototype owns a `publish` function (the production path), and wraps the input directly when it doesn't (test mocks). Combined with the `publishBatched` wrap fix above, `live.derived()` now works correctly across multiple connected clients.

- **`live.webhook()` docstring corrected.** The previous comment claimed the Vite plugin auto-generates a SvelteKit `+server.js` endpoint for webhook exports. The plugin only marks them as known so they're not flagged "not wrapped in `live()`"; users are expected to wire the endpoint themselves by importing the handler and calling `.handle({ body, headers, platform })` from a POST handler. README "Webhooks" section already showed the correct pattern; only the JSDoc was misleading.

### Internal

- **Channels / rooms / cron / derived multi-page e2e** (24 new scenarios x 2 dev/prod = 48 cases, total e2e 78 → 168). New spec files: `test/e2e/{channels,room,derived,cron}.spec.js`. New fixtures: `test/fixture/src/live/{channels,room,derived,cronjobs}.js` plus matching pages under `test/fixture/src/routes/`. Channels coverage proves cross-client static + presence + dynamic-topic isolation. Rooms coverage proves data + presence + cursors + cross-client `addCard` action + auto-leave-on-disconnect (the latter required adding `close` and `unsubscribe` re-exports to `test/fixture/src/hooks.ws.js`; the existing fixture had no close hook so realtime's per-subscription cleanup never fired on WS drop). Derived coverage proves cross-client recompute fan-out, multi-source, debounce coalescing, dynamic per-arg isolation, and late-join initial-fetch hydration. Cron coverage proves auto-publish (return value -> `set` event), manual `ctx.publish`, multi-client fan-out, late-join, and a sanity check that cron is independent of pubsub triggers (uses an exported `_tickCron()` for deterministic firing instead of clock-minute alignment).

- **Tier-4 docker-compose chaos harness for cross-instance pubsub.** New `test/chaos/` directory with `docker-compose.yml` (one Redis container with OS-assigned host port, so it never collides with productive Redis instances on the same machine), `instance-server.js` (fixture prod-build entrypoint that reads `REDIS_URL` from env), `global-setup.js` / `global-teardown.js` (orchestrates docker compose up + spawns two svelte-realtime instances on OS-assigned ports), `multi-instance.spec.js` (5 scenarios), and a separate `playwright.config.js`. The fixture's `hooks.ws.js` now wires the extensions Redis pubsub bus when `REDIS_URL` is set: `bus.activate(platform)` in the `open` hook subscribes the local instance to incoming Redis fan-out, and `bus.wrap(platform)` in the `message` hook routes outgoing publishes through Redis + local. When `REDIS_URL` is unset, behavior is identical to the previous fixture (existing 168 e2e cases pass unchanged). New `npm run test:chaos` script. Fixture deps now include `ioredis` and `svelte-adapter-uws-extensions`.

### Added

- **Production assertions with structured metrics.** New `assert(cond, category, context)` helper exported from `svelte-realtime/server` and `svelte-realtime/client` instruments invariants at 7 hot-path sites (envelope shape on incoming RPC frames, subscription bookkeeping consistency, push-registry compare-and-delete, lock-waiter shape, optimistic-queue server-state pairing, drain-precondition, settle entry shape). On violation: increments a per-category in-memory counter (read via `getAssertionCounters()`), fires the new Prometheus counter `svelte_realtime_assertion_violations_total{category}` when `live.metrics(...)` is wired, and logs a `[realtime/assert] {...}` line. In test mode (`VITEST` or `NODE_ENV=test`) the assert throws so vitest surfaces the failure; in production it does NOT throw because a thrown exception inside a publish hot-path microtask could leave a half-applied bookkeeping update. Categories are stable strings prefixed `realtime/<module>.<invariant>` so the Prometheus label cardinality is bounded (~7 today) and does not collide with the adapter's `extensions_assertion_violations_total`. README "Production assertions" section documents every category and their site.

- **Bounded-by-default capacity caps with documented saturation behavior.** Five new caps surface a "Capacity model" section in the README that maps every internal Map / Set / array with caller-driven growth to a default value plus a saturation behavior (REJECT, WARN-ONLY, FIFO-evict, or WARN-then-skip). New exports from `svelte-realtime/server`: `MAX_PUSH_REGISTRY` (10,000,000, WARN-then-skip on the per-userId connection registry), `TOPIC_WS_COUNTS_WARN_THRESHOLD` (1,000,000, WARN-only on the per-topic subscriber index since eviction would corrupt routing), `SILENT_TOPIC_WARN_DEDUP_MAX` (1,000,000, FIFO-evict), `PUBLISH_RATE_WARN_DEDUP_MAX` (1,000,000, FIFO-evict). New export from `svelte-realtime/client`: `MAX_OPTIMISTIC_QUEUE_DEPTH` (1,000, REJECT). All five mirror the canonical sizing from svelte-adapter-uws + svelte-adapter-uws-extensions so an app reading docs across the three packages sees consistent scales. Existing caps (rate-limit identities, throttle/debounce timers, idempotency results, presence refs, history, devtools rings) are now documented in the same section.

### Fixed

- **Vite plugin now generates client stubs for `live.lock(...)` and `live.idempotent(...)` exports.** Previously the static-analysis regex only matched `= live(` / `= live.stream(` / `= live.validated(` / `= live.rateLimit(`, so a top-level export like `export const settleInvoice = live.lock(...)` was silently warned as "not wrapped in live()" and produced no client stub. The exports were callable from the server but not from any page that imported them via `$live/<module>`. The plugin now treats `live.lock` and `live.idempotent` exports identically to a plain `live(...)` export: client stub generated, registered in the live registry, type declarations emitted. The runtime side was already correct.

- **Pre-existing crash in the Vite plugin's `configureServer` hook.** A dead `const originalLoad = this.load;` line at `vite.js:785` crashed dev-server boot under newer Vite versions (`Cannot read properties of undefined (reading 'load')`) because `this` is not bound to the plugin in modern Vite. The line was unused and has been removed.

### Internal

- **End-to-end coverage for `live.validated()` and the `presence` / `cursor` merge strategies.** Three new spec files run twice per CI pass (dev + prod): `test/e2e/schema-validation.spec.js` (9 scenarios x 2 = 18 cases) proves that `live.validated(schema, fn)` rejects invalid payloads with `RpcError('VALIDATION', ...)` carrying the structured `issues` array, accepts valid payloads, surfaces deep paths (`user.name`, `items.<index>`) on nested-schema failures, and isolates per-call failures across concurrent contexts. `test/e2e/presence.spec.js` (6 x 2 = 12 cases) proves `merge: 'presence'` join / leave / refreshed events round-trip across multiple connected clients, including late-join initial-fetch hydration and key-stable in-place updates. `test/e2e/cursor.spec.js` (6 x 2 = 12 cases) covers `merge: 'cursor'` update / remove with the same multi-page coverage. Fixture additions: `test/fixture/src/live/{schema,presence,cursor}.js` plus matching pages under `test/fixture/src/routes/`. e2e total goes from 78 to 120 cases per pass.

- **End-to-end test harness mirroring the adapter pattern.** New `test/fixture/` (in-tree minimal SvelteKit app declaring `"svelte-realtime": "file:../.."`) and `test/e2e/` (Playwright config, dev/prod server starters, global setup/teardown). 39 scenarios run twice per CI pass: once against the Vite dev server, once against the built production server (`vite build` + `node build/index.js`). Coverage: 10 queue-replay scenarios (single mutate happy/fail, concurrent A+B failures, A succeeds B fails, A fails B succeeds, server-confirm absorb, server-unrelated interleave, free-form mutate concurrent fail, three concurrent mixed outcomes, drain + post-drain hot path), 2 lock scenarios (FIFO serialization with non-overlap invariant, `maxWaitMs` `LOCK_TIMEOUT`), 3 smoke scenarios (initial fetch, RPC roundtrip, server publish reflected in subscribed UI), 13 multi-page scenarios using parallel `BrowserContext`s to prove cross-connection pubsub fan-out, late-join replay, cross-client optimistic absorb (success and failure paths), cross-client lock contention, and a 10-key stress publish; 4 reconnect scenarios that force a server-initiated WS close mid-mutate and prove the optimistic queue rolls back cleanly + auto-reconnect catches up missed events; and 6 per-user auth scenarios using `BrowserContext.addCookies()` to give each context a distinct fake identity (proves `ctx.user` reaches RPC handlers, per-user stream isolation via dynamic topics keyed on `ctx.user.id`, cross-user routing, and role-gated guards). 78 total test cases per CI pass. Fixture pages expose a `window.__test` API so test scenarios drive the full client-side flow via `page.evaluate` (no `expect.poll` workarounds masking real ordering bugs). New `npm run test:e2e` script. `test-results/` and `playwright-report/` ignored.

- **Property-based test coverage for `store.mutate` queue-replay correctness.** Added `fast-check` as a dev dependency and 4 property tests under `__stream() mutate queue-replay property tests` that drive random sequences of (server-event, mutate-start, mutate-settle) operations against a real stream and compare the final displayed value to a brute-force reference model. The reference is a straight transcription of the design contract in plain JS: server events build a server-state, in-flight mutate-starts open queued entries, mutate-settles either graduate (success + not absorbed) or just remove the entry. Properties run 100 / 60 / 25 / 60 random iterations per `it` block (245 total per test run) covering: final-state matches reference, all-fail leaves only initial + applied server events (no phantoms), absorbed mutate yields the same state as the server event alone, post-drain server events apply via the hot path. No production code change.

### Changed

- **`store.mutate(asyncOp, optimisticChange)` now uses always-on queue replay.** Pending mutations are tracked in an in-flight queue and the displayed value is recomputed by replaying that queue against the un-overlaid server state after every server event and every settle. The public API is unchanged; the win is that concurrent mutates roll back independently. If A and B are both in flight and both fail, the displayed state returns to the latest server state with no phantom traces of either A or B (the prior snapshot/restore approach could leak state between overlapping rollbacks). Server events with a key matching a queue entry's optimistic key absorb the entry, so the typical "client generates UUID, server confirms with same id" flow continues to reconcile without flicker.

  Steady-state hot path is unchanged: when no `mutate` is in flight, the per-event work is identical to before plus a single `_optimisticQueue.length === 0` branch check. Free-form mutator semantics are also unchanged: shallow draft (slice for arrays, object spread otherwise), top-level shape changes participate in replay cleanly, in-place item field mutations are NOT isolated.

### Added

- **Bounded wait for `live.lock` via `maxWaitMs`.** Pass `maxWaitMs` (in the config-object form) to bound how long a queued caller will wait before giving up. On timeout the wrapper rejects with `LiveError('LOCK_TIMEOUT', ...)` so the client receives a typed error with `.code === 'LOCK_TIMEOUT'`, plus `.key` and `.maxWaitMs` fields for observability. The current holder's handler is **not** interrupted; only the waiting caller gives up. Subsequent waiters on the same key are unaffected and continue in their original FIFO position.

  ```js
  export const settleInvoice = live.lock(
    { key: (ctx, id) => `invoice:${id}`, maxWaitMs: 5000 },
    async (ctx, id) => settle(id)
  );
  ```

  The default in-process lock and `createDistributedLock` from the extensions package both honor it; for custom lock implementations, the option is forwarded as the third argument: `lockInst.withLock(key, fn, { maxWaitMs })`. Validation runs at registration: non-numeric, non-finite, or negative values throw with a `[svelte-realtime]`-prefixed error.

### Changed

- **Peer-dep bump: `svelte-adapter-uws` `^0.5.0-next.10`** (was `^0.5.0-next.7`). Required for the new `lock.withLock(key, fn, { maxWaitMs })` primitive consumed by `live.lock`'s `maxWaitMs` option above. The intervening `next.8` and `next.9` releases also ship framework invariant assertions, bounded-by-default capacity caps across adapter core and bundled plugins, and additional chaos scenarios on the test harness; consumers can opt into those independently. Heads-up if you call the adapter's lock plugin directly: `lock.clear()` now rejects pending waiters with a typed `LOCK_CLEARED` error instead of leaving them hanging, so any code that ignored `clear()`-driven rejections needs a `catch`.

- **Default in-process lock backing `live.lock` rewritten as a per-key FIFO waiter queue.** Replaces the prior `Map<string, Promise>` chain so that `maxWaitMs` cancellations can skip cancelled waiters cleanly without breaking FIFO ordering for the rest of the queue. Behavior for existing call sites without `maxWaitMs` is identical: same FIFO, same parallelism across keys, same handler-error propagation that unblocks the next waiter.

### Documentation

- **New "Request correlation" section** documenting how `ctx.requestId` flows from the wire envelope (or `X-Request-ID` header) through `live()` handlers and into the `svelte-adapter-uws-extensions` postgres tasks/jobs APIs. Includes both call shapes (explicit `{ requestId: ctx.requestId }` and the `{ platform: ctx.platform }` auto-extract form), a SQL example showing how to join `ws_tasks` and `ws_jobs` rows back to the originating RPC, and a note about keeping the id out of Prometheus label sets to avoid cardinality blowup.

### Changed

- **`live.push({ userId }, ...)` gains cluster-routing fallback via `live.configurePush({ remoteRegistry })`.** When a `remoteRegistry` is configured (the connection registry from `svelte-adapter-uws-extensions/redis/registry` is the intended consumer), `live.push` falls back to `remoteRegistry.request(userId, event, data, options)` whenever the userId is not registered on the calling instance. The local in-process Map populated by `pushHooks.open` / `pushHooks.close` continues to win when an entry is present, so single-instance setups see no behavior change.

  ```js
  import { live } from 'svelte-realtime/server';
  import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry';

  const registry = createConnectionRegistry(redis, { identify: (ws) => ws.getUserData()?.userId });
  live.configurePush({ remoteRegistry: registry });
  // live.push({ userId: 'u-on-other-server' }, 'event', data) now reaches that user.
  ```

  `live.configurePush` accepts the new field independently of `identify`; both can be set in one call. Errors from the remote registry layer (offline / timeout / handler error) propagate as-is rather than being translated to `LiveError('NOT_FOUND')` so callers can distinguish "no connection anywhere in the cluster" from "connection found but the request failed in transit." Single-instance behavior (no registry configured, unknown userId) still throws `LiveError('NOT_FOUND')`.

- **Transform throws on the publish path now route to per-stream `onError`.** When a `live.stream()` is configured with both `transform` and `onError`, an exception thrown from inside the transform on a `ctx.publish()` call now fires the configured `onError(err, null, topic)` observer (with `null` ctx, since the transform runs in the publish-helper closure rather than a handler context). The publish itself is dropped silently for that frame because the projected wire data is invalid.

  Streams configured with `transform` but no `onError` keep the prior behavior: the throw propagates up out of `ctx.publish()`, surfacing as an `INTERNAL_ERROR` on the originating RPC. Apps that haven't opted into the observer pattern still see failures the way they did before.

  Closes the documented remaining-delta from the per-stream `onError` boundary: loader throws were already routed (initial subscribe, stale-reload, `.load()` SSR), but per-publish transform throws went unobserved. Apps with a `transform` typo or unexpected null-field can now catch the failure once via `onError` instead of cascading into every RPC that touches the topic.

- **`coalesceBy` extractor throws on the publish path now route to per-stream `onError`.** Symmetric closure of the same publish-path observability gap for the other user-supplied function in the closure. When a `live.stream()` is configured with both `coalesceBy` and `onError`, an exception thrown from inside the coalesce-key extractor on a `ctx.publish()` call now fires the configured `onError(err, null, topic)` observer (with `null` ctx, same contract as the transform path). The publish itself is dropped silently for that frame because there is no key to fan out under.

  Streams configured with `coalesceBy` but no `onError` keep the prior behavior: the throw propagates up out of `ctx.publish()`, surfacing as an `INTERNAL_ERROR` on the originating RPC.

  Apps with a `coalesceBy` extractor that may throw on edge-case payloads (null fields, unexpected shapes) can now catch the failure once via `onError` instead of cascading into every RPC that touches the topic.

### Added

- **DevTools per-stream payload preview.** Click any stream row in the dev-mode overlay to expand a list of the 20 most recent pub/sub envelopes (time + event + JSON data). Pretty / Raw toggle controls JSON rendering verbosity (Pretty truncates at ~200 chars, Raw at ~500). Pause stops capture without affecting the live `last:` timestamp; Clear events drops every stream's ring buffer.

  Captured payloads are walked once at write time with key-based redaction. Default redact list: `password`, `token`, `apiKey` / `api_key`, `secret`, `authorization`, `cookie`, `sessionid` / `session_id`, `csrf` / `csrftoken`. Match is case-insensitive and exact-key. Override at runtime:

  ```js
  import { __devtools } from 'svelte-realtime/client';
  if (__devtools) __devtools.redactKeys.add('ssn');
  ```

  Recursion capped at depth 5 (deeper objects show `'[depth-cap]'`); arrays capped at 50 items (overflow shows `'[+N more]'`). Pretty/Raw and Pause states persist across reloads via `localStorage`. Production builds are unaffected: the entire instrumentation is gated behind `import.meta.env.PROD`.

- **Curried form for `rpc.createOptimistic`.** Pass two arguments instead of three (`store, change`) and the call returns a `(...callArgs) => Promise` callable bound to that store + change. Useful when one optimistic-update setup applies to many call sites with different args.

  ```js
  const optimisticSend = sendMessage.createOptimistic(
    messages,
    (current, args) => [...current, { id: tempId(), text: args[0] }]
  );
  await optimisticSend('Hello!');
  await optimisticSend('There!');
  ```

  The three-argument direct form (`rpc.createOptimistic(store, callArgs, change)`) continues to work unchanged. Arity-2 vs arity-3 detection at call site.

- **Stream-side `store.createOptimistic(rpc, callArgs, change)`.** Same flow as `rpc.createOptimistic(store, callArgs, change)`, expressed from the stream's perspective. Identical semantics; pick whichever reads more naturally for the call site.

- **`createTestContext({ user })` builder in `svelte-realtime/test`.** Returns a `ctx`-shaped object suitable for direct unit tests of guards or predicates: `expect(myGuard(createTestContext({ user })))`. Mirrors the production `_buildCtx` shape; helper methods (`publish`, `throttle`, `signal`, `shed`, etc.) are no-ops returning sensible defaults so predicates that read `ctx.user` / `ctx.cursor` work without setup. Reach for `createTestEnv()` only when you need full publish/subscribe round-trips.

- **`stream.simulatePublish(event, data)` on the test stream return.** Discoverable shorthand for `env.platform.publish(stream.topic, event, data)` that lives where tests are already focused. Throws a clear error if called before the stream's topic is known (i.e. before the initial subscribe round-trip lands).

- **Chaos harness on `createTestEnv`.** Pass `chaos: { dropRate, seed }` to drop a configurable fraction of `platform.publish` events at the platform layer; pair with a string `seed` for deterministic, replayable drop sequences. Used to write resilience tests against pub/sub message loss without spinning a real cluster.

  ```js
  import { createTestEnv } from 'svelte-realtime/test';

  const env = createTestEnv({ chaos: { dropRate: 0.5, seed: 'rep-1234' } });
  env.register('chat', chat);
  // ... half of every publish dropped, same sequence across runs.

  // Runtime control:
  env.chaos.set({ dropRate: 1.0 }); // drop everything
  env.chaos.disable();
  env.chaos.dropped; // counter
  env.chaos.resetCounter();
  ```

  Currently models the `drop-outbound` scenario only -- pub/sub events to subscribers are dropped. RPC replies (`platform.send`) are exempt because timing them out would just hang test code.

- **`invalidateOn` option on `live.stream()` for topic-driven loader reruns.** Declare a glob-style pattern (or array of patterns) and any `ctx.publish` whose topic matches triggers a rerun of the stream's loader, with the result broadcast as a `refreshed` event so every subscriber gets the new state. Useful for mutations whose effects don't fit the merge-strategy model cleanly (bulk operations, server-side recomputation, cascading writes).

  ```js
  export const todos = live.stream('todos', loadTodos, {
    merge: 'crud',
    invalidateOn: 'todos:*'
  });

  // Anywhere in your live functions:
  ctx.publish('todos:bulk-imported', 'created', { count: 42 });
  // -> matches 'todos:*', the todos loader reruns, the result is broadcast
  //    as a 'refreshed' event, every subscriber gets the new state.
  ```

  `*` is the wildcard (matches any sequence of one or more characters; other regex specials are escaped). Multiple patterns are OR-ed. Reloads dedupe via a per-watcher `reloading` flag, so concurrent triggers while a reload is in flight collapse to one rerun. `refreshed` events are excluded from the invalidation check so a pattern that happens to match its own stream's topic does not loop.

  Reuses the staleness-watchdog machinery for the rerun (captures the first subscriber's `ctx` + args, applies the init `transform` if configured, broadcasts as `refreshed`). Loader throws on the reload path route through the same `onError(err, ctx, topic)` observer as the staleness path.

- **DevTools Streams tab now shows merge strategy, last-event age, and per-stream error state.** The dev-mode overlay panel (toggle with `Ctrl+Shift+L`) gains three new fields per stream entry: `merge` (the configured merge strategy), `last:<event> <age>` (event name and relative age of the most recent pub/sub frame), and `err: <code> -- <message>` (when the stream is in the error state, cleared on recovery). Existing fields (path, topic, subscriber count) unchanged. The RPC and Connection tabs are unchanged.

  Production builds are unaffected -- the overlay and its instrumentation are stripped via the `import.meta.env.PROD` gate.

- **`rpc.createOptimistic(store, callArgs, optimisticChange)` shorthand on every generated RPC stub.** Sugar for `store.mutate(() => rpc(...callArgs), wrappedChange)` that threads `callArgs` into the optimistic-change callback so call sites don't have to capture them in a closure.

  ```js
  import { sendMessage, messages } from '$live/chat';

  await sendMessage.createOptimistic(
    messages,
    ['Hello!'],
    (current, args) => [...current, { id: tempId(), text: args[0] }]
  );
  ```

  `callArgs` is always an array (single-arg RPCs use `[arg]`). The third argument accepts the same two shapes as `store.mutate()`: a `(current, args) => newValue` function or a `{ event, data }` object. Behavior on success/rollback/server-confirmation is identical to `store.mutate()`; the shorthand is purely syntactic. Reach for `store.mutate()` directly when the asyncOp isn't an RPC (third-party API call, multi-step flow).

- **Build-time `defineTopics` registry check in the Vite plugin.** When the plugin sees a `defineTopics({...})` call anywhere under `src/`, it parses the patterns and validates string-literal topics passed to `live.stream(...)` and `live.channel(...)` against the registry. A literal that does not match any registered pattern triggers a one-shot warning naming the file and the offending topic, suggesting either adding the topic to `defineTopics` or calling `TOPICS.<name>(...)` instead.

  ```
  [svelte-realtime] src/live/feed.js: live.stream topic 'mistyped-topic' is not in
  your TOPICS registry. Either add it to defineTopics({...}) or call TOPICS.<name>(...)
  instead of passing a string literal.
  ```

  Covers static-string patterns and arrow-return template literals; template interpolations are matched as `.+` so any value satisfies the placeholder. Dynamic values (function references, spreads) are silently skipped at parse time. Projects without any `defineTopics` call get no warnings -- the check is opt-in via adopting the registry helper.

  Closes the most-common-by-far class of "I changed the SQL trigger but forgot to update the topic string" bugs at build time, without runtime overhead.

- **`expectGuardRejects(promise, expectedCode?)` helper in `svelte-realtime/test`.** Ergonomic wrapper for the common "this call should be denied" assertion: awaits the promise, asserts it rejected with a `LiveError` of the expected code (default `'FORBIDDEN'`), and returns the rejected error so further assertions can run on it.

  ```js
  import { createTestEnv, expectGuardRejects } from 'svelte-realtime/test';

  const env = createTestEnv();
  env.register('admin', adminModule);

  const user = env.connect({ role: 'viewer' });
  await expectGuardRejects(user.call('admin/destroyAll'));
  await expectGuardRejects(env.connect(null).call('admin/destroyAll'), 'UNAUTHENTICATED');

  const err = await expectGuardRejects(user.call('admin/destroyAll'));
  expect(err.message).toMatch(/admin role/);
  ```

  Throws a clear `[svelte-realtime]`-prefixed error if the promise resolves, rejects with a non-`LiveError`, or rejects with a different code. Pairs with the existing `createTestEnv()` harness; no separate setup needed.

- **Dev-mode silent-topic warning via `live.silentTopicWarning()`.** When a stream subscribes to a topic and no events arrive within a configurable window (default 30 seconds), the framework logs a one-shot `console.warn` naming the topic and the common causes -- a missing `pg_notify` trigger, a missing handler-side `ctx.publish()`, or an intentionally low-traffic topic the user can suppress. Closes the most-common-by-far class of "the realtime stream isn't updating" debugging sessions.

  ```js
  import { live } from 'svelte-realtime/server';

  // Lower the bar (default 30s)
  live.silentTopicWarning({ thresholdMs: 5000 });

  // Suppress per-topic for known-quiet streams
  live.silentTopicWarning({ suppress: ['admin:audit', 'cron:reports'] });

  // Disable globally
  live.silentTopicWarning(false);
  ```

  Topics starting with `__` (system topics: `__realtime`, `__signal:*`, `__custom`) are skipped automatically; users don't need to populate `suppress` for them. Each topic warns at most once per process; the warning never fires for a topic that has seen at least one event, and re-subscribing after a warn does not re-fire. The watchdog arms on the first subscriber to a topic, observes every publish, and disarms when the last subscriber leaves.

  Hard-gated to `NODE_ENV !== 'production'`: the activation gate is constant-folded by Vite/Rollup so production builds carry zero overhead regardless of configuration. The watchdog state is never touched in production paths.

  Reuses the same lifecycle hook points as the existing staleness watchdog (`staleAfterMs`); apps using both features share the per-topic registry machinery.

- **Svelte 5 store helpers `store.rune()` and `store.map(fn)` on every stream store.** Generated `$live/*` streams now expose a `.rune()` method that returns a Svelte-5 reactive object backed by the stream's value, and a `.map(fn)` method that projects each item of an array stream through `fn` and returns a composable mapped store.

  ```svelte
  <script>
    import { todos } from '$live/todos';

    // Svelte 5: reactive { current } via fromStore
    const items = todos.rune();

    // Per-item projection (works in both Svelte 4 and 5)
    const titles = todos.map(t => t.title);

    // Composes with rune() for Svelte 5 fine-grained reactivity
    const titlesRune = todos.map(t => t.title).rune();
  </script>

  <p>{items.current?.length ?? 0} items</p>
  {#each $titles as title}<li>{title}</li>{/each}
  ```

  `rune()` calls `fromStore` from `svelte/store` under the hood; reading `current` inside an effect or component subscribes via Svelte's `createSubscriber` for fine-grained reactivity, and reading it outside an effect synchronously returns the latest value. Throws under Svelte 4 (where `fromStore` is not exported) so apps still on Svelte 4 see a clear error instead of silent confusion -- they should keep using the existing `Readable<T>` interface via `$store` auto-subscribe.

  `.map(fn)` returns an object with the same `{ subscribe, rune, map }` shape as the source, so it composes with `$`-prefix auto-subscription (`$mapped`), with `.rune()` for Svelte 5 fine-grained reactivity, and chains via further `.map()` calls. Semantics match the documented `($stream ?? []).map(fn)` pattern: a `null` or `undefined` source emits `[]`, an array source emits `source.map(fn)`, and a non-array source (set-merge stream, paginated wrapper) emits `[]` after a dev-mode `console.warn`. Subscriptions are lazy: the source is only subscribed while at least one mapped consumer is active. Sidesteps the `$derived(() => ...)` footgun where storing a function reference instead of its return value silently breaks rendering.

  No new exports beyond the methods on the stream store. The existing `subscribe` interface is unchanged; apps that don't call `.rune()` or `.map()` see no behavior change.

### Changed

- **Editing a `src/live/*.js` file now triggers an HMR update instead of a full page reload.** The Vite plugin's generated client stubs (the virtual `$live/*` modules) now emit `if (import.meta.hot) import.meta.hot.accept();`, which lets Vite re-execute the stub in place when the source file changes. The server-side handler reload was already wired (the registry virtual module reloads via `_hmrReloadRegistry`); the client-side accept directive was the missing piece that made Vite fall back to a full page reload.

  Wire from any consumer that already had HMR working (Svelte components, `+page.server.js` files): editing a handler updates without losing scroll position, form state, or open subscriptions. Pure addition to the generated stub output. Production builds dead-strip the `if (import.meta.hot)` block.

  No API change; no per-app wiring needed. Apps that import from `$live/...` automatically benefit.

- **Multi-stream page mounts now batch their wire-level subscribes into one frame.** When several streams subscribe in the same microtask (the typical multi-widget page mount), the underlying WebSocket subscribe frames now collapse into one `subscribe-batch` frame instead of N individual `subscribe` frames. Apps that wired their auth check via `hooks.ws.js`'s `subscribeBatch` export now see one auth call covering every topic on the page, instead of N per-topic `subscribe` calls.

  Wire-frame count for a 5-stream page mount drops from 6 (one batched RPC envelope plus 5 subscribe frames) to 2 (one batched RPC envelope plus one `subscribe-batch` frame). On reconnect the same shape was already emitted; this closes the gap on initial mount.

  Transparent improvement -- no realtime API change. Apps automatically benefit when the adapter peer is on `^0.5.0-next.7` (the new floor). Apps that haven't wired `subscribeBatch` server-side still get the wire-frame reduction; the user's per-topic `subscribe` hook continues to work via the adapter's per-topic fallback.

### Added

- **Stream staleness watchdog and per-stream `onError` boundary on `live.stream()`.** Two new `StreamOptions` fields for streams whose underlying source can quietly stop emitting (CDC drops, polling stalls, upstream cache evicts the key) or whose loader can fail mid-flight (database timeouts, transient backend errors).

  ```js
  // src/live/dashboard.js
  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    async (ctx, orgId) => loadAudit(orgId),
    {
      merge: 'crud',
      key: 'id',
      staleAfterMs: 30_000,
      onError: (err, ctx, topic) => log.warn({ err, topic }, 'audit stream error')
    }
  );
  ```

  `staleAfterMs` arms a per-topic watchdog on the first subscribe. Every `ctx.publish` to the topic resets the timer; if no events arrive for the configured duration, the realtime layer re-runs the stream's loader and broadcasts the result as a `refreshed` event. The client merges `refreshed` as a full-state replacement across every merge strategy: `crud` swaps the array and rebuilds its key index, `set` replaces the value, `latest` swaps the buffer, `presence` and `cursor` swap and rebuild indexes. Optimistic-key tracking from `store.optimistic()` / `store.mutate()` is cleared on receive (the server's snapshot is authoritative).

  Watchdog state is per-topic, not per-subscriber. Multiple subscribers to the same topic share one timer; the timer arms on the first subscribe and clears when the last subscriber leaves. The reload uses the first subscriber's `ctx` and `args`, which is correct for shared topics since the loader's output is identical regardless of which subscriber's ctx triggers it.

  `onError(err, ctx, topic)` is an observer-only hook: it fires when the loader throws on the initial subscribe path, on the staleness-driven reload, or on the `.load()` SSR path. Errors thrown inside `onError` are silently swallowed so a buggy logger never breaks the original error path. The original error continues to propagate to the caller (or, on stale-reload, drives the timer re-arm). Sibling to the global `onError` setter from `svelte-realtime/server` -- per-stream observers fire alongside the global one, not instead of it.

  Apps that want a topic-scoped degraded signal can publish a system event from inside the handler:

  ```js
  onError: (err, ctx, topic) => {
    ctx.publish(`__system:${topic}`, 'degraded', { reason: err.message });
  }
  ```

  Both options are independent: a stream can declare `staleAfterMs` without `onError`, or vice versa. Apps that don't use either pay zero overhead -- the publish-helper's watchdog reset is gated behind a Map size check, and the loader try/catch only inspects `__streamOnError` when set.

  Validation runs at registration: `staleAfterMs` must be a positive finite number; `onError` must be a function. Misconfiguration fails fast at app boot with a `[svelte-realtime]`-prefixed error.

- **Server-initiated push via `live.push()` and client-side `onPush()`.** New primitive on the `live` function namespace for sending a request to a connected user and awaiting their reply. Routes through a per-instance userId -> WebSocket registry maintained by a small pair of hooks.

  ```js
  // hooks.ws.js - wire the registry once
  import { pushHooks } from 'svelte-realtime/server';
  export const open = pushHooks.open;
  export const close = pushHooks.close;
  ```

  ```js
  // anywhere on the server (admin RPC, cron, webhook receiver, etc.)
  import { live } from 'svelte-realtime/server';

  const reply = await live.push(
    { userId: 'u-123' },
    'confirm-delete',
    { itemId: 42 },
    { timeoutMs: 30_000 }
  );
  if (reply.confirmed) await actuallyDelete(42);
  ```

  ```svelte
  <script>
    import { onPush } from 'svelte-realtime/client';

    onPush('confirm-delete', async ({ itemId }) => {
      return { confirmed: confirm(`Delete item ${itemId}?`) };
    });
  </script>
  ```

  Default identifier reads `ws.getUserData()?.user_id ?? ws.getUserData()?.userId`. Override with `live.configurePush({ identify: (ws) => ... })` for custom userData shapes; pass `null` to restore the default. Anonymous connections (identify returning null/undefined) are silently skipped at registration so they cannot be push targets.

  Returns whatever the client's `onPush` handler returns. Throws `LiveError('NOT_FOUND')` if no connection is registered for the userId. Propagates `Error('request timed out')` from the underlying platform primitive on the configurable `timeoutMs` (default 5000ms), and `Error('connection closed')` if the WebSocket closes before reply.

  Multi-device users see most-recent-connection-wins routing: a second connection by the same user replaces the first as the push target; older connections still receive topic publishes via their own subscriptions, only push routing flips. The reverse index handles fast device-swap sequences correctly so `close` on a stale ws does not deregister the active connection.

  Client-side `onPush(event, handler)` multiplexes multiple events over the adapter's single `onRequest` channel, so apps install one handler per event without overwriting each other. Returns an unsubscribe function. Throwing from a handler rejects the server-side promise.

  Single-instance routing only in this slice: a user's connection must live on the same server process that calls `live.push`. Cluster-wide push (any instance routing to any user's WebSocket) requires the connection-registry primitive in the extensions package.

  Requires `svelte-adapter-uws@^0.5.0-next.4` for the underlying `platform.request` and `onRequest` primitives.

- **`realtimeTransport()` SvelteKit transport hook preset.** New `svelte-realtime/hooks` entry point. Auto-registers serialization for `RpcError` and `LiveError` across the SSR / client boundary so typed errors thrown during `+page.server.js` `load()` arrive at `+error.svelte` (and any client-side handler that rethrows them) preserved as the original class with `code` intact, rather than as plain `Error` instances.

  ```js
  // src/hooks.js
  import { realtimeTransport } from 'svelte-realtime/hooks';

  export const transport = realtimeTransport();
  ```

  Compose with app-defined types (user entries win on key conflict):

  ```js
  // src/hooks.js
  import { realtimeTransport } from 'svelte-realtime/hooks';
  import { Vector } from '$lib/geometry';

  export const transport = realtimeTransport({
    Vector: {
      encode: (v) => v instanceof Vector && [v.x, v.y],
      decode: ([x, y]) => new Vector(x, y)
    }
  });
  ```

  Wire from `src/hooks.js` (the shared hook), NOT `hooks.server.js`. SvelteKit's transport primitive needs both encode (server-side) and decode (client-side hydration) visible at build time. `RpcError`'s optional `issues` field (carried by `live.validated()` failures) survives the round-trip. Validation runs at registration: malformed extras (missing or non-function `encode`/`decode`) throw immediately so misconfiguration fails fast at app boot.

- **`fallback` + `onError` options on `.load()` for partial SSR degradation.** When you wire many streams into a `+page.server.js` `load()`, a single failing loader currently throws and SvelteKit shows the error page, taking down every other stream on the page. The new opt-in options let one failure render an empty placeholder while the rest of the page loads:

  ```js
  // +page.server.js
  import { auditFeed, presence, reactions } from '$live/dashboard';

  export async function load({ locals, platform }) {
    const [audit, presenceData, reacts] = await Promise.all([
      auditFeed.load(platform, {
        user: locals.user,
        args: [locals.user.organization_id],
        fallback: [],
        onError: (err) => locals.log.error({ err }, 'audit feed SSR failed')
      }),
      presence.load(platform, { user: locals.user, fallback: {} }),
      reactions.load(platform, { user: locals.user, fallback: [] })
    ]);
    return { audit, presenceData, reacts };
  }
  ```

  The client hydrates the fallback value for the failing stream; the WebSocket subscribe attempts the load again on connect once the page is interactive, so the user sees a placeholder during SSR and the live stream once the connection comes up.

  Opt-in via the PRESENCE of the `fallback` key -- the value itself can be anything (empty array, sentinel object, even `null` or `undefined`). Without `fallback`, errors propagate as before (back-compat). `onError` is optional; observer hooks throwing are silently swallowed so a buggy logger never breaks SSR. Errors caught: loader throws, validation, guard, access filter, missing handler. `null` returns from gated streams (`live.gate`) pass through unchanged -- the gate's "no data" decision is not treated as an error.

- **`health` store on the client for system-wide degraded / recovered detection.** A new top-level Readable from `svelte-realtime/client` reflects the realtime system's health, sourced from `degraded` / `recovered` events on the `__realtime` topic. Apps can render a "real-time updates paused, reconnecting..." banner when the upstream pub/sub bus's circuit breaker trips, without wiring the system topic by hand:

  ```svelte
  <script>
    import { health } from 'svelte-realtime/client';
  </script>

  {#if $health === 'degraded'}
    <Banner severity="warn">Real-time updates paused, reconnecting...</Banner>
  {/if}
  ```

  Initial value is `'healthy'`. Flips to `'degraded'` on a server-published `degraded` event, back to `'healthy'` on `recovered`. Subscription is lazy: the realtime client only subscribes to `__realtime` once a consumer first reads the store. Apps that never use `health` pay no cost for the subscription.

  The store deliberately exposes only the state, not the underlying payload. Apps that need richer detail (reason strings, timestamps, etc.) can listen to the topic directly via `import { on } from 'svelte-adapter-uws/client'; on('__realtime').subscribe(...)`. Server-side wiring lives outside this package -- the extensions package's pub/sub bus publishes the events when its circuit breaker changes state; this is the consumer side.

- **`store.mutate(asyncOp, optimisticChange)` for optimistic mutations with auto-rollback.** Wraps the existing per-stream `optimistic()` pattern with the missing async pairing: applies a local change synchronously, awaits the async operation, leaves the store as-is on success (server's confirming event reconciles), rolls back on failure. The asyncOp's result becomes the method's return value.

  ```js
  // Event-based: server's confirming `created` event replaces the placeholder.
  const todo = await todos.mutate(
    () => createTodo({ title: 'Buy milk' }),
    { event: 'created', data: { id: tempId(), title: 'Buy milk' } }
  );

  // Free-form mutator: bypass the merge strategy for arbitrary local changes.
  await todos.mutate(
    () => removeTodo('foo'),
    (current) => current.filter(t => t.id !== 'foo')
  );
  ```

  Two patterns for the optimistic change argument:

  - **`{ event, data }`** uses the stream's merge strategy (`crud` / `set` / `latest` / `presence` / `cursor`) -- same path as the existing `store.optimistic(event, data)` returning a manual rollback. The typical client-generated-UUID pattern with crud merge composes naturally: the server's confirming `created` event replaces the placeholder via key match, leaving the store with the real server-assigned record.
  - **`(current) => newValue`** runs a free-form mutator on a copy of the current value. Return the new value, OR mutate in place and return undefined (both styles work). Useful for changes that don't fit a single merge event (filters, multi-item rearrangements, complex updates).

  The existing `store.optimistic(event, data)` returning a manual rollback is unchanged. `mutate()` is a higher-level wrapper for the common "RPC + matching local update + auto-rollback on failure" pattern.

  Replay-safety caveat: snapshot/restore. Concurrent optimistic mutations or interleaved server events on the same stream can lose state on rollback. Snapshot is shallow (slice for arrays); top-level shape changes (push, pop, filter, splice) are rolled back cleanly, in-place mutations of individual item fields are NOT (the snapshot and draft share item references). Replace whole items rather than mutating fields: `draft[i] = { ...draft[i], name: 'x' }`.

- **`defineTopics(map)` helper for centralizing topic patterns.** A small registry helper so stream definitions and any out-of-band consumers (SQL triggers, Postgres NOTIFY shapes, doc generators, devtools panels) reference one source of truth instead of scattering string literals across the codebase.

  ```js
  // src/lib/topics.js
  import { defineTopics } from 'svelte-realtime/server';

  export const TOPICS = defineTopics({
    audit:    (orgId)       => `audit:${orgId}`,
    security: (orgId)       => `security:${orgId}`,
    feed:     (orgId, kind) => `feed:${orgId}:${kind}`,
    systemNotices: 'system:notices'
  });
  ```

  Stream definitions reference the registry directly:

  ```js
  import { TOPICS } from '$lib/topics';
  import { live } from 'svelte-realtime/server';

  export const auditFeed = live.stream(
    (ctx, orgId) => TOPICS.audit(orgId),
    loadAudit
  );
  ```

  Returned object exposes the same entries the input did, plus two non-enumerable metadata properties for tooling and docs:

  - `__patterns` -- `name -> pattern string` map derived by calling each function with sentinel placeholders matching its arity (`{arg0}`, `{arg1}`, ...). Useful for generating SQL trigger comments or doc-site cross-references that won't drift from the live registry.
  - `__definedTopics: true` -- runtime marker tools can use to detect a topic registry.

  Validation runs at registration: empty entries, non-string-non-function entries, or use of reserved names (`__patterns`, `__definedTopics`) throws immediately so misconfiguration fails fast at app boot.

  Doesn't solve the SQL/TypeScript boundary by itself, but makes mismatches greppable (one canonical reference per topic name) and registry-checkable (tooling can compare `TOPICS.__patterns` against the actual SQL or NOTIFY shapes).

- **`onUnsubscribe(ctx, topic, remainingSubscribers)` -- third argument exposes the remaining subscriber count.** When the last consumer of a stream leaves, the hook can now tear down the upstream feed without app-side bookkeeping. Backwards-compatible: existing handlers ignoring the extra argument keep working unchanged.

  ```js
  export const orderFeed = live.stream(
    (ctx, orgId) => `orders:${orgId}`,
    loadOrders,
    {
      onSubscribe: (ctx, topic) => upstream.subscribe(topic),
      onUnsubscribe: (ctx, topic, remaining) => {
        if (remaining === 0) upstream.unsubscribe(topic);
      }
    }
  );
  ```

  `remainingSubscribers` is the count of OTHER WebSockets still holding a realtime-stream subscription to the topic after the current one drops. The hook fires once per logical subscription on the dropping connection (mirroring `onSubscribe` firings); every firing for one drain sees the same `remainingSubscribers` value, so the `=== 0` check inside the hook is meaningful regardless of how many logical subs the dropping ws had.

  Replaces the common app-side pattern of "maintain my own per-topic ws set" -- the realtime layer was already tracking exactly this information for its own bookkeeping.

- **`quiescent` store on the client for "all streams settled" detection.** A new top-level Readable from `svelte-realtime/client` emits `true` when every active stream has finished loading (or errored) and `false` while at least one is fetching or recovering. Drop a single page-level loading state at the moment all streams settle, instead of flickering one spinner per stream:

  ```svelte
  <script>
    import { quiescent } from 'svelte-realtime/client';
    import { auditFeed, presence, reactions } from '$live/dashboard';
    const a = auditFeed.subscribe(/* ... */);
    const p = presence.subscribe(/* ... */);
    const r = reactions.subscribe(/* ... */);
  </script>

  {#if !$quiescent}
    <Spinner />
  {:else}
    <Dashboard />
  {/if}
  ```

  The same signal also detects "all streams have caught up after a reconnect" -- watch for a `false -> true` transition while the adapter's connection status is `'open'`. Pair with the `failure` store and the adapter's `status` store to render a complete connection state per page.

  Streams contribute to the in-flight count from their first subscriber until they reach `'connected'` or `'error'`. A stream defined but never subscribed does not count. Initial value is `true` (no streams yet).

- **`live.lock(keyOrConfig, fn)` for per-key serialization.** Wraps an RPC handler so concurrent calls that resolve to the same lock key run one at a time in FIFO order; calls on different keys run in parallel. Same composable shape as `live.validated` / `live.idempotent` / `live.rateLimit`.

  ```js
  // Per-org leaderboard recompute: only one in-flight recompute per org
  export const recomputeLeaderboard = live.lock(
    (ctx) => `leaderboard:${ctx.user.organization_id}`,
    async (ctx) => {
      const rows = await db.expensive.recompute(ctx.user.organization_id);
      ctx.publish(`org:${ctx.user.organization_id}:leaderboard`, 'set', rows);
      return rows;
    }
  );

  // Static key (single global section)
  export const rebuildSearchIndex = live.lock(
    'search-index-rebuild',
    async (ctx) => { /* ... */ }
  );

  // Custom lock implementation (multi-instance via Redis, etc.)
  // Any object exposing withLock(key, fn) works.
  export const settleInvoice = live.lock(
    { key: (ctx, id) => `invoice:${id}`, lock: customLock },
    live.validated(InvoiceIdSchema, async (ctx, id) => settle(id))
  );
  ```

  Use for cron-ish triggers, expensive recompute, single-flight cache fills, and atomic read-modify-write on shared records.

  Key resolver returning `null`, `undefined`, or `''` bypasses the lock entirely for that call (the handler runs unguarded). Handler errors propagate to the caller and do NOT block subsequent waiters. Composes with the rest of the `live.*` wrapper family.

  Default lock is in-process. For multi-instance deployments, pass any object exposing `withLock(key, fn)` matching the contract via `{ lock }`.

- **Typed subscribe-denial codes on stream `error` stores.** When the server's `subscribe` hook denies a stream subscription, the denial reason now arrives on the stream's existing `error` store as a typed `RpcError` whose `code` is the canonical denial code. Apps can render targeted UI per cause instead of decoding a generic `INTERNAL_ERROR`:

  ```svelte
  <script>
    import { auditFeed } from '$live/audit';
    const err = auditFeed.error;
  </script>

  {#if $err?.code === 'UNAUTHENTICATED'}
    <p>Please sign in to view audit history.</p>
  {:else if $err?.code === 'FORBIDDEN'}
    <p>You don't have access to this organization's audit log.</p>
  {:else if $err?.code === 'RATE_LIMITED'}
    <p>Too many requests. Please wait a moment.</p>
  {:else if $err?.code === 'INVALID_TOPIC'}
    <p>Invalid feed identifier.</p>
  {:else if $err}
    <p>Audit feed unavailable: {$err.message}</p>
  {/if}
  ```

  Canonical codes: `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_TOPIC`, `RATE_LIMITED`. Custom strings the server's `subscribe` hook returns are passed through verbatim as `code` (e.g. `KYC_PENDING`, `PLAN_LOCKED`), so apps can switch on app-specific reasons too. The denial routes via the adapter's `denials` Readable; `stream.error` is the existing `RpcError | null` store, no new public API.

  Same denial naturally fans out to every stream subscribed to the same topic. Stream lifecycle handles the listener wiring: registers on first successful stream RPC (when the topic is known), deregisters on `cleanup()` so HMR / unsubscribe / re-subscribe behave predictably.

- **Dev-mode publish-rate warning.** When a topic crosses 200 events/sec (default, configurable), a one-shot `console.warn` fires pointing at the two natural mitigations:

  ```
  [svelte-realtime] Topic 'cursor:42' is publishing 800 events/sec.
    For high-frequency streams, consider one of:
      live.stream(topic, loader, { coalesceBy: (data) => data.userId })  // latest-value-wins, queued per subscriber
      live.stream(topic, loader, { volatile: true })                     // drop on backpressure, best-effort
    See: https://svti.me/highfreq
  ```

  The two strategies have different intents: `coalesceBy` keeps the latest value per key and replaces the pending value on each new publish (best for cursors, prices, presence -- you want the latest value to land); `volatile: true` drops on backpressure with no buffering (best for typing indicators, telemetry pings -- a missed frame is gone for good). Pick the one that matches the topic's intent.

  Topics already configured with EITHER `coalesceBy` or `volatile: true` are silently skipped -- the user has already chosen their tool, no need to nag. The warning surfaces a real optimization apps miss because they don't know it exists. It runs only in development builds (hard-gated to `NODE_ENV !== 'production'`); production has zero cost. One warning per topic per process so the output never gets noisy. The sampler reads `platform.pressure.topPublishers` which the adapter is already maintaining, so the only added cost in development is one `setInterval` per platform with no per-publish overhead.

  Configurable via `live.publishRateWarning(...)`:

  ```js
  // hooks.ws.js or a startup module

  // Disable entirely (CLI tooling, noisy environments)
  live.publishRateWarning(false);

  // Lower the bar for noisier insight
  live.publishRateWarning({ threshold: 50 });

  // Sample more frequently than the 5s default
  live.publishRateWarning({ threshold: 200, intervalMs: 1000 });
  ```

  Validation runs at registration: invalid `threshold` / `intervalMs` (non-positive, non-finite, wrong type) throws immediately so misconfiguration fails fast.

- **`failure` store on the client for typed reconnect-failure UI.** A new top-level export from `svelte-realtime/client` carries the cause of the most recent non-open connection-status transition, so apps can render targeted UI per failure class instead of decoding close codes themselves.

  ```svelte
  <script>
    import { failure } from 'svelte-realtime/client';
    import { status } from 'svelte-adapter-uws/client';
  </script>

  {#if $failure?.class === 'TERMINAL'}
    <p class="error">Session expired. <a href="/login">Sign in again</a></p>
  {:else if $failure?.class === 'EXHAUSTED'}
    <button onclick={() => location.reload()}>Reconnect</button>
  {:else if $failure?.class === 'THROTTLE'}
    <p class="warn">Server is busy, retrying shortly...</p>
  {:else if $failure?.class === 'AUTH'}
    <p class="error">Could not authenticate (HTTP {$failure.status})</p>
  {:else if $status === 'disconnected'}
    <span>Reconnecting...</span>
  {/if}
  ```

  Discriminated union on `kind`:

  - `{ kind: 'ws-close', class: 'TERMINAL' | 'EXHAUSTED' | 'THROTTLE' | 'RETRY', code, reason }` for WebSocket closes.
  - `{ kind: 'auth-preflight', class: 'AUTH', status, reason }` for `configure({ auth: true })` preflight failures. HTTP `status` (not `code`) so `4401` close vs `401` preflight cannot be confused.

  Five classes:

  - `TERMINAL` -- server permanently rejected the client (1008 / 4401 / 4403). Retry loop stopped.
  - `EXHAUSTED` -- `maxReconnectAttempts` hit; the network never recovered.
  - `THROTTLE` -- server signalled rate-limiting (4429). Reconnect still scheduled, jumped ahead in the backoff curve.
  - `RETRY` -- normal transient drop (1006 abnormal, network blip, server restart). Reconnect in progress.
  - `AUTH` -- `configure({ auth: true })` HTTP preflight failed before the WebSocket was opened. 4xx is terminal; 5xx and network errors retry.

  Lifecycle: `null` while connected (or before any failure), set on the failing transition, cleared on the next successful `'open'`. NOT set on intentional `close()` -- the deliberate-end state is `failure === null` paired with the underlying `status === 'failed'`. Types `Failure` and `FailureClass` are exported alongside.

  Requires `svelte-adapter-uws@^0.5.0-next.5` (peer floor bumped from `next.4`); the store is a one-line re-export of the adapter's `failure` primitive with no transformation.

- **`ctx.requestId` for correlation logging.** The adapter assigns a correlation id per WebSocket connection (stable across every event on that connection) and per HTTP request, honoring an inbound `X-Request-ID` when present. Surfaced on `LiveContext` and `CronContext` so handlers can structured-log the same id from every step of one user's interaction without piping it through their handler signatures.

  ```js
  export default live(async (ctx, input) => {
    log.info({ requestId: ctx.requestId, userId: ctx.user?.id }, 'order received');
    const order = await db.orders.create(input);
    return order;
  });
  ```

  Requires `svelte-adapter-uws@^0.5.0-next.4` (already the peer floor) for the underlying `platform.requestId`. Platforms that don't set it leave `ctx.requestId` as `undefined`.

- **`volatile: true` option on `live.stream()` for fire-and-forget streams.** Marks a stream as intentionally drop-on-backpressure -- typing indicators, cursor positions, telemetry pings, anything where a missed frame is gone for good. Two effects:

  - Disables per-event seq stamping for the topic (passes `seq: false` through to the adapter). A reconnect carrying `lastSeenSeq` won't try to backfill the gaps, which is the correct semantic for these stream shapes.
  - Declares intent so the option's presence makes the stream's volatility self-documenting at the call site.

  ```js
  export const cursors = live.stream(
    (ctx, roomId) => `room:${roomId}:cursors`,
    async () => loadInitialCursors(),
    { merge: 'cursor', volatile: true }
  );

  // Per-call form (e.g. inside an RPC handler that fires telemetry pings):
  ctx.publish('telemetry/ping', 'tick', { ts: Date.now() }, { volatile: true });
  ```

  Wire-level "drop on backpressure" is the adapter's default behavior across `platform.publish`, `platform.publishBatched`, and `platform.send` -- uWS auto-skips any subscriber whose outbound buffer is over `maxBackpressure` (default 64 KB), per-connection, while non-backpressured subscribers still receive the frame. So `volatile: true` is mostly an intent-declaration + seq-stamping decision on this side; the actual frame-drop happens automatically below us.

  Cannot combine with `coalesceBy` (latest-value-wins requires a queue; volatile drops on backpressure -- different intents) or `replay` (volatile messages aren't buffered for resume). Both combinations throw at registration with a guiding error message.

- **Dev-mode shape check on `.hydrate()`.** When `.hydrate()` is called with a value that doesn't match the stream's merge strategy (`crud` / `latest` / `presence` / `cursor` expect arrays; `set` accepts anything), a one-shot `console.warn` fires with the stream path, the configured merge strategy, and the actual type that was passed. Caught early, the fix is usually a missing `.data` unwrap on a paginated SSR response or a typo in the merge option. Stripped from production builds via the existing `process.env.NODE_ENV` gate. `null` and `undefined` are treated as "no data yet" and never warn.

- **`live.rateLimits({ default, overrides, exempt })` for registry-level RPC rate limiting.** Configure rate limits centrally instead of wrapping every handler with `live.rateLimit(...)`. The default rule applies to every RPC path that doesn't have its own per-handler wrapping; per-path overrides tighten or loosen specific paths; `exempt` opts paths out entirely.

  ```js
  // hooks.ws.js or a startup module
  live.rateLimits({
    default: { points: 200, window: 10_000 },
    overrides: {
      'chat/sendMessage': { points: 50, window: 10_000 },
      'orders/create':    { points: 5,  window: 60_000 }
    },
    exempt: ['presence/moveCursor', 'cursor/move']
  });
  ```

  Resolution order per call: `exempt` -> per-handler `live.rateLimit(...)` wrapping (explicit wins over central) -> `overrides[path]` -> `default` -> none. Per-path buckets are keyed by `(path, ctx.user.id)` and use the same sliding-window logic as the existing `live.rateLimit` decorator -- both share one bucket map and one sweep timer. Rejected calls return `{ ok: false, code: 'RATE_LIMITED', retryAfter }` matching the existing wrapper's failure shape.

  Stream subscribes are not rate-limited by this primitive (subscribe-rate shaping is the adapter's concern). Pass `null` to clear the registry. Validation runs at registration: invalid `points` / `window` / unknown shape throws immediately so misconfiguration shows up at boot rather than mid-traffic.

- **Automatic wire-level publish batching.** Every `ctx.publish()` made within one microtask now flushes as a single batched WebSocket frame to each subscriber, instead of one frame per call. A handler that publishes 50 items in a `for` loop produces ONE outbound frame per subscriber, not 50. No code change required -- handlers keep using `ctx.publish` exactly as before. Subscribers that don't advertise the `'batch'` capability fall back to per-event delivery automatically.

  ```js
  // Bulk import: 50 ctx.publish calls => 1 frame per subscriber
  export const importItems = live(async (ctx, items) => {
    const created = await db.bulkInsert('items', items);
    for (const row of created) {
      ctx.publish(`org:${ctx.user.organization_id}:items`, 'created', row);
    }
  });
  ```

  Behavior preserved across the existing per-topic features:

  - Streams configured with `coalesceBy` continue to use `platform.sendCoalesced` per-subscriber (latest-value-wins replacement). Those publishes do not enter the batched path -- the two primitives produce different wire shapes intentionally.
  - Streams configured with `transform` apply the projection BEFORE queuing into the batch. Subscribers see the projected wire data; `coalesceBy` extractors still see the original.
  - `ctx.batch([msgs])` (the documented 0.4.0 list form) is unchanged.
  - `ctx.throttle`, `ctx.debounce`, and `ctx.signal` retain their own scheduling and are not auto-batched.

  Each `await` boundary inside a handler crosses a microtask, so publishes interleaved with awaits flush in their natural order rather than being held until handler exit -- the timing semantics every existing handler depends on still hold. Requires `svelte-adapter-uws@^0.5.0-next.4` for the underlying `platform.publishBatched` primitive; older adapters fall back transparently to per-event publishes.

- **Org/user-scoped access predicates + `guard({ authenticated })` + `live.scoped()`.** Four small pieces that close the most common authorization-bypass holes without per-handler boilerplate or magic auto-detection.

  ```js
  // Module-level auth declarative shorthand
  export const _guard = guard({ authenticated: true });

  // Stream: subscriber's org must match the topic arg
  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    loader,
    { access: live.access.org() }
  );

  // RPC: the input's orgId must match the caller's org
  export const updateOrg = live.scoped(
    live.access.org({ from: (ctx, input) => input.orgId }),
    live.validated(schema, async (ctx, input) => updateOrg(input))
  );

  // Compose multiple predicates (e.g. own-user OR admin)
  const isAdmin = (ctx) => ctx.user?.role === 'admin';
  export const adminOrSelfFeed = live.stream(
    (ctx, userId) => `notes:${userId}`,
    loader,
    { access: live.access.any(isAdmin, live.access.user()) }
  );
  ```

  - **`guard({ authenticated: true })`** -- declarative shorthand. Throws `UNAUTHENTICATED` when `ctx.user` is null. Composes with function-style middleware via `guard(...)`'s variadic args: `guard({ authenticated: true }, customCheck)`.
  - **`live.access.org(opts?)`** -- predicate returning `true` when an extracted value (default arg 0) equals `ctx.user.organization_id` (default field). Returns `false` for null users (anonymous never passes). Configurable via `from` and `orgField`.
  - **`live.access.user(opts?)`** -- predicate returning `true` when an extracted value (default arg 0) equals `ctx.user.user_id` (default field, matching `[table]_id` convention). Configurable via `from` and `userField`.
  - **`live.scoped(predicate, fn)`** -- wraps an RPC handler with a predicate. Throws `UNAUTHENTICATED` (no user) or `FORBIDDEN` (user present) when the predicate returns false. Async predicates are awaited. Composes with `live.validated`, `live.rateLimit`, etc. Streams use the `access` option instead.
  - **Stream `access` predicates now receive args.** `access(ctx, ...args)` lets the new args-aware helpers fire on the right value. Existing predicates that take only `ctx` are unaffected (extra args ignored).
  - **`live.access.any` / `.all` forward args** so `org()` and `user()` predicates compose. Existing call sites are unchanged.

  Defaults follow the SQL `[table]_id` convention (`user_id`, `organization_id`). Override per-helper if your data shape differs (e.g. `live.access.org({ orgField: 'tenant_id' })`).

- **`transform` option on `live.stream()` for server-side projection.** Define the wire shape once; the framework applies it to BOTH the initial loader result AND every subsequent live publish for that topic. Typical 80-90% payload reduction on data-heavy streams (audit logs, dashboards, anything where the database row has 30 columns and the client needs 4).

  ```js
  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    async (ctx, orgId) => db.auditRows.recent(orgId, 50),
    {
      merge: 'crud', key: 'id',
      transform: (row) => ({
        id: row.record_id,
        op: row.operation,
        at: row.changed_at
      })
    }
  );
  ```

  Applied per-item for array results (covers `crud` / `latest` / `presence` / `cursor` merge) and to the whole value for non-arrays (covers `set` merge). Paginated loader responses (`{ data, hasMore, cursor }`) transform `.data` only. Composes with `coalesceBy` (the key extractor sees ORIGINAL pre-transform data; subscribers see the transformed wire shape). Streams without `transform` are unaffected. Works through `.load()` for SSR. The transform must be synchronous.

  Implementation note: pre-subscribe publishes for a topic go through raw (the per-topic transform registry is populated when the first subscriber arrives). For typical app patterns this is invisible since publishes follow subscribes.

- **`args` schema option on `live.stream()`.** Validates the stream's argument tuple at subscribe time, BEFORE the topic function runs -- prevents topic injection via malformed dynamic-topic args. Accepts any Standard Schema-compatible schema (Zod, ArkType, Valibot v1+, etc.); the schema validates the whole args tuple, so use `z.tuple([...])` or the equivalent.

  ```js
  import { z } from 'zod';

  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    async (ctx, orgId) => loadFeed(orgId),
    { args: z.tuple([z.string().uuid()]) }
  );
  ```

  Validation failures reject the subscribe with code `VALIDATION` and a populated `issues` array, matching the existing `live.validated()` shape. Validated/coerced args reach the topic function and the loader, so Zod transforms (e.g. `z.string().toLowerCase()`) apply downstream. Streams without `args` are unaffected -- back-compat preserved. Works through `.load()` for SSR too.

- **Per-RPC `timeout` override via `.with({ timeout })`.** Long-running queries no longer have to share the global 30s timeout. Pass a per-call override to wait longer:

  ```js
  // Wait up to 2 minutes for this report
  const report = await generateReport.with({ timeout: 120_000 })(params);

  // Composes with idempotency
  await charge.with({ idempotencyKey: 'k1', timeout: 90_000 })(payload);
  ```

  Resolution order: per-call `timeout` > global `configure({ timeout })` > 30s default. Timeout-only `.with()` calls do NOT dedup against the base path within a microtask -- the longer-waiting caller would otherwise be rejected at the shorter call's timeout. Idempotency dedup still applies when `idempotencyKey` is set. Per-call `timeout` is ignored inside `batch(fn)` (the batch-level timer governs all collected calls).

  The error message now reflects the actual timeout (`RPC 'foo/bar' timed out after 120s` instead of always saying "30s"), and the device-sleep detection threshold scales with the effective timeout so longer overrides don't misfire as `SLEEP_TIMEOUT`.

- **Structured guard error codes + descriptive `.load()` error.** Two ergonomics fixes that work together:

  - **Bare `Error` thrown from a `guard()` is now auto-classified.** Previously, `throw new Error('login required')` from a guard reached the client as `INTERNAL_ERROR` (5xx-class, generic "Internal server error" message). Now it becomes `UNAUTHENTICATED` when `ctx.user` is null, `FORBIDDEN` when present -- 4xx-class with the matching generic message ("Authentication required" / "Access denied"). The original error is preserved on `.cause` for server-side logging without leaking to the wire. Throwing `new LiveError('FORBIDDEN', 'Account suspended')` directly continues to propagate code AND message verbatim, for guards that want a specific reason.

  - **`.load()` on a guarded stream now throws a descriptive Error when called without a user.** Previously it warned in dev and called the guard with `ctx.user = null`, producing a confusing downstream failure. Now omitting `user` entirely is treated as a developer mistake and surfaces immediately:

    ```
    [svelte-realtime] 'audit/feed' has a guard but .load() was called without a user.
      Pass it explicitly:    stream.load(platform, { user: locals.user })
      Or opt into anonymous: stream.load(platform, { user: null })
      See: https://svti.me/ssr
    ```

    Passing `user: null` explicitly continues to bypass this check (anonymous opt-in), so apps that legitimately call guarded streams without a user (e.g., a public read with a permissive guard) keep working.

  - **Access predicates now pick the right code too.** `live.stream({ access: () => false })` previously always returned `FORBIDDEN`; now returns `UNAUTHENTICATED` when `ctx.user` is null and `FORBIDDEN` otherwise.

  Standard guard / framework codes are now documented on `LiveError`: `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, `VALIDATION`, `OVERLOADED`, `CONFLICT`, `SERVICE_UNAVAILABLE`, `NOT_FOUND`, `INVALID_REQUEST`, `INTERNAL_ERROR`. User-thrown codes (e.g. `INSUFFICIENT_FUNDS`) continue to pass through unchanged.

- **`live.admission({ classes })` + `ctx.shed(className)` + `classOfService` option** -- pressure-aware shedding. Configure named classes of service, each mapped to either an array of pressure reasons or a `(snapshot) => boolean` predicate; the framework evaluates them against the adapter's `platform.pressure` snapshot.

  Two ways to act on the result:

  - **Manual**: `if (ctx.shed('background')) throw new LiveError('OVERLOADED', 'try again later');` -- the handler decides what to do (throw, return cached, log, etc.).
  - **Declarative**: `live.stream(topic, loader, { classOfService: 'background' })` -- the server auto-rejects new subscribes to that stream with `OVERLOADED` when the class's rule matches current pressure. Existing subscribers are unaffected.

  ```js
  // hooks.server.js
  import { live } from 'svelte-realtime';

  live.admission({
    classes: {
      critical:    [],                                          // never shed
      interactive: ['MEMORY'],                                  // shed only on memory pressure
      background:  ['MEMORY', 'PUBLISH_RATE', 'SUBSCRIBERS']    // shed on any pressure
    }
  });

  // src/live/browse-list.ts
  export const browseList = live.stream('browse:list', loader, {
    classOfService: 'background'
  });
  ```

  Zero overhead when never called: `ctx.shed` returns `false` and `classOfService` is a no-op without `live.admission(...)`. Unknown class names throw at runtime (typo defense). Pressure reasons are validated at registration: `MEMORY`, `PUBLISH_RATE`, `SUBSCRIBERS`, `NONE` -- mirroring the adapter's enum.

- **`delta.fromSeq(sinceSeq)` on `live.stream()`** -- the user-provided bridge tier for three-tier reconnect. When a client reconnects with a `seq` older than the bounded replay buffer can satisfy, the server now calls `delta.fromSeq(clientSeq)` to fetch missed events from the durable store (typically Postgres) before falling back to a full rehydrate. Resolution order on subscribe-with-seq is now:

  1. **Replay buffer** (`platform.replay.since`) -- bounded, fast.
  2. **`delta.fromSeq(clientSeq)`** -- user-provided database query, unbounded.
  3. **Full rehydrate** via the loader -- always safe.

  Returning `null`/`undefined` falls through to the next tier. Returning `[]` means "nothing missed" (no-op for the client). Each event should carry a `seq` field so the client's `_lastSeq` advances; if events lack `seq`, the response's top-level `seq` falls back to `platform.replay.seq(topic)` when available.

  ```js
  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    async (ctx, orgId) => loadRecentAudit(orgId),
    {
      replay: true,
      delta: {
        fromSeq: async (sinceSeq) => db.audit
          .where('seq', '>', sinceSeq)
          .orderBy('seq', 'asc')
          .get()
      }
    }
  );
  ```

  Coexists with the existing schema-version `delta.version` / `delta.diff` (orthogonal -- schema vs event continuity).

- **`coalesceBy` option on `live.stream()`** turns a stream into a latest-value stream under backpressure. With `coalesceBy: (data) => data.auctionId` set, every `ctx.publish(topic, event, data)` for that stream's topic fans out via the adapter's per-socket `sendCoalesced` instead of broadcasting via `publish`. Each subscriber holds at most one pending message per `(topic, coalesceBy(data))` key: if a newer publish arrives before the previous frame drains to the wire, the older value is dropped in place. Latest value wins. Use for high-frequency streams where intermediate values are noise: price ticks, cursor positions, presence state, scrub positions. For at-least-once delivery, leave the option unset and the broadcast path is byte-identical to today.

  ```js
  export const auctionPrice = live.stream(
    (ctx, auctionId) => `auction:${auctionId}`,
    async (ctx, auctionId) => loadCurrentPrice(auctionId),
    { merge: 'set', coalesceBy: (data) => data.auctionId }
  );
  ```

- **`live.idempotent({ keyFrom?, store?, ttl? }, fn)`** wraps an RPC handler so that retries with the same key return the cached result without re-running the handler. Two ways to supply the key:
  - **Server-derived:** `keyFrom: (ctx, input) => \`order:${ctx.user.id}:${input.clientOrderId}\`` -- the framework computes the key, the client doesn't need to know about idempotency.
  - **Client-supplied:** the client calls `createOrder.with({ idempotencyKey: crypto.randomUUID() })(payload)` and the key rides on the wire envelope.

  Default TTL is 48 hours. Default store is a bounded in-process map (zero-config). Concurrent in-flight calls with the same key share one handler invocation; only successful results are cached, so a thrown handler aborts the slot and the next caller re-runs. Composes with `live()`, `live.validated()`, `live.rateLimit()`, and other wrappers. For multi-instance deployments, pass `store: createIdempotencyStore(redis)` from `svelte-adapter-uws-extensions/idempotency` -- the in-process store and the distributed store implement the same three-state `acquire(key, ttlSec)` contract, so the swap is a one-line change.

  Until now, the only client-side dedup was a microtask-window collapse of identical RPC calls (`_dedupMap`). That helped against double-clicks but did nothing for a retry 200 ms later: the server happily re-ran the handler. This closes that gap.

## [0.4.23] - 2026-04-27

### Fixed

- **`live.metrics()` documentation now matches a working integration.** The README's "Prometheus metrics" example imported a non-existent `createMetricsRegistry` from `svelte-adapter-uws-extensions/prometheus`, and the `server.d.ts` JSDoc example imported a non-existent `createRegistry`. The real export is `createMetrics`, and its registry methods take positional args (`counter(name, help, labelNames)`) where `live.metrics()` calls them with options-object form (`counter({ name, help, labelNames })`). The README now shows a six-line adapter that bridges the two and is paired with `metrics.handler` for the `/metrics` endpoint. JSDoc and type declarations updated to match.

### Added

- **`MetricsRegistry` interface in `server.d.ts`.** TypeScript users now get autocomplete and structural validation on the registry shape passed to `live.metrics()`, replacing the previous `registry: any` signature.
- **Integration test exercising the real extensions registry.** `test/server.test.js` now imports `createMetrics` from `svelte-adapter-uws-extensions/prometheus` and runs the documented adapter shim against it, asserting that RPC counters, the duration histogram, the error counter, the stream subscription gauge, and the cron counter all flow through to the registry's serialized output. Catches future regressions in either package's exports or method shape.

---

## [0.4.22] - 2026-04-17

### Added

- **`configure({ auth })` forwards to the adapter's connect preflight.** Pass `true` to use the default `/__ws/auth` path or a string to override it. Required behind Cloudflare Tunnel and other strict edge proxies that silently drop `Set-Cookie` on WebSocket `101 Switching Protocols` responses, and to opt into the `authenticate` hook shipped in `svelte-adapter-uws` 0.4.12. Fully backwards compatible -- callers that don't pass `auth` behave identically. Until now this required reaching past `svelte-realtime/client` to seed the adapter singleton manually.
- **Cloudflare-Tunnel symptom detector.** When the client observes two consecutive WebSocket `open -> close` cycles inside one second with no time spent in the open state, it logs a one-shot `console.warn` pointing at `https://svti.me/cf-cookies` with the fix. The warning is suppressed when `configure({ auth })` is already set. This catches the silent-1006 production failure mode that traditionally takes hours to diagnose.

### Changed

- **Peer dependency `svelte-adapter-uws` bumped to `>=0.4.12`** so the new `auth` option and `authenticate` hook are guaranteed to be available. Older versions silently ignored unknown `connect()` options anyway, but pinning the floor makes the new docs trustworthy.

---

## [0.4.21] - 2026-04-16

### Breaking Changes

- **Stream store errors no longer replace the data value.** Previously, connection failures, timeouts, and rejected fetches set the store value to `{ error: RpcError }`, replacing whatever data was there. This caused `($store ?? []).filter(...)` and similar patterns to crash with a TypeError because the error object is truthy but not an array. The store value now always holds your data type (or `undefined` while loading). Errors are surfaced on a separate `.error` store instead.

  **Migration:** Replace `$store?.error` checks with `store.error` (a `Readable<RpcError | null>`):

  ```diff
  - {#if $messages?.error}
  -   <p>{$messages.error.message}</p>
  + const err = messages.error;
  + {#if $err}
  +   <p>{$err.message}</p>
  ```

  Code that only uses `$store === undefined` for loading and otherwise treats the value as data requires no changes.

### Added

- **`.error` and `.status` reactive stores on every stream.** `store.error` is a `Readable<RpcError | null>` that holds the current error (or `null` when healthy). `store.status` is a `Readable<'loading' | 'connected' | 'reconnecting' | 'error'>` that tracks connection state. Both clear automatically on successful reconnect and reset on cleanup.

---

## [0.4.20] - 2026-04-14

### Fixed

- **`live.derived()` recomputation now receives `ctx.user` from the subscribing client.** Dynamic derived compute functions that check `ctx.user` (e.g. auth guards like `if (orgId !== ctx.user.organization_id)`) previously crashed with a TypeError because `ctx.user` was always null during recomputation. The user data from the first subscriber is now stored on the derived instance and passed through to the compute function.
- **Lazy-registered derived streams no longer prevent `_activateDerived` from wrapping `platform.publish`.** When `__registerDerived` received a lazy loader, it returned before setting `_hasDynamicDerived = true`, causing `_activateDerived` to skip wrapping if called before the lazy queue resolved. The flag is now set eagerly when the lazy entry is queued.
- **Dynamic derived topic separator changed from `\x00` to `~`.** The null byte separator was rejected by svelte-adapter-uws at multiple levels: the `esc()` envelope quoter throws on control characters, and subscribe validation silently drops topics containing them. Dynamic derived topics now use `~` (e.g. `dashboard/stats~org_123`), which is printable and compatible with the adapter's topic constraints.

### Added

- **Dev-mode warning when `_activateDerived(platform)` was not called.** When a client subscribes to a `live.derived()` stream and `_activateDerived` has never been called, a one-time console warning is emitted in non-production environments. This catches the silent misconfiguration where SSR hydration works but live updates never arrive.

---

## [0.4.19] - 2026-04-13

### Added

- **Standard Schema support for `live.validated()`.** Any [Standard Schema](https://standardschema.dev/)-compatible validator now works out of the box -- Zod, ArkType, Valibot v1+, and others. The `~standard` interface is checked first; existing Zod `.safeParse` and Valibot `._run` paths are preserved as legacy fallbacks. Async schemas are rejected with a clear error. (PR #3 by @joshua1)

---

## [0.4.18] - 2026-04-12

### Fixed

- **`live.derived()` streams now subscribe correctly via RPC.** Derived streams were using an auto-generated `__derived:` topic prefix that collided with the reserved-prefix validation in the RPC handler, silently rejecting every subscription. `__registerDerived` now overrides the topic to use the stream path (e.g. `dashboard/stats` instead of `__derived:7`), which is consistent with how every other stream type works. Dynamic derived topics use the same path base with args appended (`dashboard/stats~orgId`). No special-case exemption needed in the validation layer.
- **Hydrated `live.derived()` stores preserve SSR data through initial subscription.** The server marks derived stream responses with a `derived` flag so the client keeps the existing hydrated value instead of replacing it with a potentially stale result. Live updates via WebSocket still apply normally on top of the hydrated data.

---

## [0.4.17] - 2026-04-12

### Fixed

- **Hydrated channel and derived stores no longer flash to empty on initial subscribe.** Added the `derived` response flag to the server and extended the client-side hydration guard to cover derived streams alongside channels.

---

## [0.4.16] - 2026-04-12

### Added

- **Dynamic `live.derived()` streams.** Source topics can now be parameterized with runtime arguments. Pass a factory function instead of a static array as the first argument: `live.derived((orgId) => [\`members:\${orgId}\`], async (ctx, orgId) => { ... })`. Each unique set of args creates an independent server-side instance with its own source subscriptions and debounce timer. Instances are created when the first subscriber connects and cleaned up automatically when the last subscriber disconnects. On the client, dynamic derived streams are called as functions, just like dynamic `live.stream()`.

---

## [0.4.15] - 2026-04-11

### Added

- **`max` option for `crud` merge strategy.** When set, the client-side buffer drops the oldest items after a `created` event exceeds the cap. In prepend mode, items are trimmed from the end of the array. In append mode, items are trimmed from the start. The key index is maintained correctly after trimming. The default for `crud` is 0 (unlimited), so existing streams are unaffected. The `latest` default remains 50. Use `{ merge: 'crud', prepend: true, max: 200 }` to cap live feeds.
- **`empty` store export.** A `Readable<undefined>` store is now exported from `svelte-realtime/client` and automatically re-exported from every generated `$live/` module. Use it as a fallback for conditional streams without needing `import { readable } from 'svelte/store'`. The generated `$types.d.ts` includes the typed export.

---

## [0.4.14] - 2026-04-10

### Changed

- Added "What the extensions handle" summary to the Redis multi-instance section, documenting cross-instance echo suppression, microtask-batched pipelines, distributed presence with zombie cleanup, replay buffer sequencing, cross-instance rate limiting, and circuit breakers.
- Added "Failure modes" section documenting what happens when Redis goes down, an instance crashes, a client reconnects after a long disconnect, send buffers overflow, and batch/queue limits are hit.
- Expanded "Clustering" section with worker architecture details: SO_REUSEPORT vs acceptor mode, batched cross-worker IPC, health monitoring with heartbeat/timeout, exponential backoff restart, and graceful shutdown behavior.
- Renamed "Limits and gotchas" to "Production limits" and added per-limit behavior descriptions, plus previously undocumented limits: presence refs (10,000), rate-limit identities (5,000), throttle/debounce timers (5,000), and topic length (256 characters).
- Mentioned Postgres LISTEN/NOTIFY as a peer alternative to Redis for cross-instance pub/sub.
- Clarified the benchmarks section to describe what is being measured (full-stack overhead including serialization, routing, and context construction, not transport protocol latency).

## [0.4.13] - 2026-04-09

### Fixed

- `.load()` now warns in dev mode when a guarded module runs with `ctx.user = null`, which usually means `{ user }` was not passed in the options. The warning fires once per path and includes the fix: `stream.load(platform, { user: locals.user })`.
- Generated `$types.d.ts` `.load()` signatures now include `user?` in the options type. Previously only `args?` was typed, so passing `{ user: locals.user }` triggered a TypeScript error even though it worked at runtime.

### Changed

- The SSR hydration example in the README now shows `{ user: locals.user }` being passed to `.load()`.
- Expanded the cross-origin and native app usage section in the README with a standalone client example using `__rpc()` and `__stream()`, and a dual cookie/token auth pattern for the upgrade hook.

## [0.4.12] - 2026-04-09

### Fixed

- RPC path validation now allows hyphens in module names. A live module at `src/live/email-queue.ts` produces the path `email-queue/queueStats`, which was rejected by the server before the handler was even resolved.

## [0.4.11] - 2026-04-09

### Fixed

- Hydrated channel streams no longer flash to empty on initial subscribe or WebSocket reconnect. Channel responses from the server return an empty placeholder (`null` or `[]`) since they have no loader. Previously this overwrote the hydrated SSR data, causing a visible glitch where derived values briefly dropped to zero or empty before live events arrived. The server now marks channel responses so the client can hold the existing value instead of replacing it.

## [0.4.10] - 2026-04-08

### Added

- `configure({ url })` option for cross-origin and native app usage. When set, the client connects to the given WebSocket URL instead of the same-origin default. This enables Svelte Native, React Native, and standalone clients to use a remote SvelteKit backend as their realtime server. Requires `svelte-adapter-uws` 0.4.8+.

## [0.4.9] - 2026-04-07

### Fixed

- SSR stubs for stream exports now include a `.hydrate()` method. Previously, calling `messages.hydrate(data)` or `stats(orgId).hydrate(data)` during server-side rendering crashed because the SSR stub was a bare `readable(undefined)` with no `.hydrate()` method.

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
