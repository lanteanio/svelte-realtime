# Changelog

All notable changes to `svelte-realtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
