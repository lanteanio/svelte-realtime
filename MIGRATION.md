# Migration guide: svelte-realtime 0.4.x to 0.5.x

This guide is organized by **tier**. Most apps only need to read the first two sections.

- **[Critical](#critical-read-first)** - runtime behavior changed; audit your code or production may break silently.
- **[Required source changes](#required-source-changes)** - won't run cleanly without these.
- **[Notable defaults and behaviors](#notable-defaults-and-behaviors)** - probably fine, but you may notice.
- **[Recommended new patterns](#recommended-new-patterns)** - not required, but better.
- **[Cosmetic](#cosmetic)** - type-only, deprecations, dead code removed.

`svelte-realtime` 0.5 raises its peerDep on `svelte-adapter-uws` to `^0.5.0`. See the adapter's MIGRATION.md for breaking changes on that side.

If you have a small app and want the 5-minute version, see the [docs site upgrade quickstart](https://svelte-realtime.dev/docs/upgrade-quickstart).

---

## Critical (read first)

These four changes close real security bugs that were sitting in idiomatic 0.4 code paths. Audit your code for the patterns described; production deploys may surface new `FORBIDDEN` / `UNAUTHENTICATED` errors and that is the framework now correctly doing its job.

### Async `access` / `filter` predicates and `live.gate` predicates no longer fail open

**What changed.** Pre-0.5, the wire-RPC stream path read `if (!streamFilter(ctx, ...))` and the SSR mirror read `if (!predicate(ctx, ...))` synchronously. An async predicate returns a Promise, which is truthy, which made the deny branch unreachable: async-deny became async-allow. Every stream guarded by `access: async (ctx) => ...` (the idiomatic shape for predicates that consult a DB / session store) silently bypassed the developer's intended gate.

The fix awaits the predicate before the truthiness check. The matching adapter-side fix in `svelte-adapter-uws@^0.5.0` makes `subscribe` / `subscribeBatch` async-safe and `platform.checkSubscribe` returns `Promise<string|null>`.

`live.access.any(...)` and `live.access.all(...)` had the same bug at the composition layer: both used `Array.prototype.some` / `every`, which read a `Promise<false>` as truthy and either short-circuited to allow (`any`) or fell through to allow (`all`). Apps composing async sub-predicates inside `any` / `all` silently bypassed every gate. The helpers now return `Promise<boolean>` and `await` each sub-predicate in order, preserving correct short-circuit semantics. The leaf helpers (`live.access.org`, `live.access.user`, `live.access.role`, `live.access.owner`, `live.access.team`) remain sync.

**How to migrate.**

- Upgrade `svelte-adapter-uws` to `^0.5.0` (already required by 0.5).
- Audit every async `access` / `filter` predicate, every async `live.gate(...)`, every async `subscribe` / `subscribeBatch` hook, and every `live.access.any(...)` / `live.access.all(...)` whose sub-predicates were async. Predicates that were silently letting requests through will now correctly deny. Expect to see new `FORBIDDEN` / `UNAUTHENTICATED` errors land on streams that were previously open.
- Sync predicates and sync `checkSubscribe` returns are unaffected (await unwraps non-Promise values transparently).
- Callers that invoked the result of `live.access.any(...)` or `live.access.all(...)` manually (rare; the typical pattern is to pass the returned predicate to `live.stream({ access })` where the runtime awaits it) must `await` the result.

### `live.idempotent` cache key is now namespaced by RPC path

**In-flight cache entries become invisible after deploy.**

**What changed.** Pre-0.5, the wrapper used the raw client-supplied `idempotencyKey` as the cache slot regardless of which RPC path was registered with it. A privileged `privateRpc.with({ idempotencyKey: 'abc' })` could be replayed by a public `publicRpc.with({ idempotencyKey: 'abc' })` and read the cached private result without invoking the public handler. The cache key sent to `store.acquire(...)` is now `'rpc:' + path + ':' + userKey`.

**This is NOT backward compatible.** In-flight cache entries from before this release become invisible after deploy: the namespaced key does not match the old un-namespaced key.

**How to migrate.**

- For Redis-backed idempotency stores: schedule the upgrade for a low-traffic window or accept that any in-flight retry that lands on the new build re-runs the handler. Old keys eventually TTL out (default 48 hours).
- For in-memory stores: entries clear on process restart, no action needed.
- Custom `keyFrom` callbacks: still encode tenant scope explicitly. The framework cannot guess the app's tenant shape; the new namespacing only closes the cross-RPC class.
- New cap: `idempotencyKey` longer than 256 characters now throws `LiveError('INVALID_REQUEST', ...)`. Pre-fix, stores accepted attacker-supplied 200KB keys.

### `ctx.publish('__*', ...)` now throws `LiveError('INVALID_TOPIC')`

**What changed.** Pre-fix, app code could call `ctx.publish('__signal:victim', ...)` or `ctx.publish('__rpc', { id: 'guess', ok: true, data })` to spoof framework-internal frames. Combined with the wire-side `__`-subscribe block, only the framework should publish system channels. `ctx.publish()` now throws `LiveError('INVALID_TOPIC', ...)` when the topic begins with `__`.

**How to migrate.**

- Server-side `live.signal()` and the plugin-side broadcasts (`__presence:*`, `__group:*`, `__replay:*`) are unaffected - they go through `platform.publish()`, not `ctx.publish()`.
- Apps that genuinely need to broadcast on a `__`-prefixed topic should reach for `platform.publish(...)` directly so the intent is explicit at the call site.
- Otherwise, rename the topic so it does not start with `__`.

### Stream-RPC subscribes consult the adapter's wire-level subscribe gate

**What changed.** Pre-0.5, a `live.stream`/`live.room` subscribe ran the loader, delivered its initial data, and (for rooms) published the presence `'join'` event BEFORE the adapter's `subscribe` / `subscribeBatch` hook chain ever fired. Apps gating private rooms via `subscribeBatch` (rather than via `live.stream({ access })` / `live.room({ guard })`) saw their loader output reach denied users. `_executeStreamRpc` now calls `platform.checkSubscribe?.(ws, topic)` after `__streamFilter` and admission checks but before `ws.subscribe(topic)` / `__onSubscribe` / loader.

**How to migrate.**

- Upgrade `svelte-adapter-uws` to `^0.5.0`.
- If your `subscribe` / `subscribeBatch` hook denies access, expect denials to land on the client's `stream.error` store as `RpcError` with the canonical denial code (`UNAUTHENTICATED` / `FORBIDDEN` / `INVALID_TOPIC` / `RATE_LIMITED`, or whatever string your hook returns). Loader output and presence joins for denied users no longer leak.
- If you were relying on the leak (you should not be), gate via `live.stream({ access })` or `live.room({ guard })` instead so the deny path runs synchronously at the realtime layer.

---

## Required source changes

These won't run cleanly until you make the change.

### Runtime: Node.js 22+ required (was Node 20+)

**What changed.** `package.json#engines.node` moved from `>=20.0.0` to `>=22.0.0`. Tracks the adapter's bump, which in turn tracks `uWebSockets.js` v20.67.0 dropping Node 20 support upstream.

**How to migrate.** See `svelte-adapter-uws/MIGRATION.md` for the full uWS-side rationale. No realtime-specific action beyond bumping your runtime to Node 22+.

### Bump `svelte-adapter-uws` peerDep

**What changed.** The peer-dep floor moved from `^0.4.0` to `^0.5.0`. Most apps will not work with an adapter older than 0.5 after upgrading - new primitives consumed by this package (`platform.checkSubscribe`, `platform.request` / `onRequest`, `platform.publishBatched`, `init` / `shutdown` lifecycle, `platform.maxPayloadLength`, `platform.bufferedAmount`, async-safe subscribe gates) are version-gated.

**How to migrate.** Bump both packages together:

```diff
- "svelte-adapter-uws": "^0.4.x"
- "svelte-realtime": "^0.4.x"
+ "svelte-adapter-uws": "^0.5.0"
+ "svelte-realtime": "^0.5.0"
```

Read the adapter's MIGRATION.md for adapter-side changes (subscribe gate semantics, `init`/`shutdown` hook contract, `maxPayloadLength` default raise from 16KB to 1MB).

### `hooks.ws.js` must export `unsubscribe` (and `close` signature changed)

**What changed.** The 0.4.0 release introduced an `unsubscribe` hook that fires in real time when a client drops a topic. The `close` hook signature changed from `({ platform })` to `({ platform, subscriptions })` and only fires `onUnsubscribe` for topics still active at disconnect time.

**How to migrate.** Re-export all three hooks from `hooks.ws.js`:

```diff
- export { message, close } from 'svelte-realtime/server';
+ export { message, close, unsubscribe } from 'svelte-realtime/server';
```

Existing destructures of `{ platform }` keep working; `subscriptions` is additive.

### `live.room()` actions require `topicArgs`

**What changed (0.4.0).** `live.room()` with actions previously inferred the argument count from `topicFn.length`. The 0.4.0 release made `topicArgs` explicit.

**How to migrate.**

```diff
  export const board = live.room(
    (ctx, boardId) => `board:${boardId}`,
+   { topicArgs: 1 },
    {
      init: async (ctx, boardId) => loadBoard(boardId),
      actions: { addCard: live(...) }
    }
  );
```

Rooms without `actions` are unaffected.

### `live.room()` `onLeave` and `onJoin` semantics

**What changed (0.4.0).** `onLeave` callback signature changed from `(ctx)` to `(ctx, topic)`. `onJoin` now runs after `initFn` succeeds; if `initFn` throws, `onJoin` is not called.

**How to migrate.**

```diff
- onLeave: (ctx) => { /* ... */ }
+ onLeave: (ctx, topic) => { /* ... */ }
```

If you relied on `onJoin` running before `initFn`, restructure: side effects that should fire regardless go in `init`'s try/catch; side effects that should only fire on a successful init stay in `onJoin`.

### `live.validated()` rejects unrecognized schema types

**What changed (0.4.0).** Previously passed input through with a dev warning. Now returns an error. Standard Schema (Zod, ArkType, Valibot v1+) is the canonical surface as of 0.4.19; legacy `.safeParse` / `._run` paths remain.

**How to migrate.** Ensure every schema is Zod, Valibot, ArkType, or another Standard Schema-compatible validator. Async schemas are rejected with a clear error.

### Reserved topic prefix `__` rejected at definition time

**What changed (0.4.0).** `live.stream()` and `live.channel()` now reject topics with the `__` prefix at definition time. Async topic functions are also rejected at definition time. Binary RPC headers >65535 bytes return `PAYLOAD_TOO_LARGE`.

**How to migrate.** Rename any `__`-prefixed topic in your stream/channel definitions. Use `platform.publish(...)` directly if you have a legitimate framework-level use case (which is rare and typically wrong).

---

## Notable defaults and behaviors

These change observable runtime behavior. Most apps are unaffected; a few will notice.

### Stream store errors no longer replace the data value (`.error` is a separate Readable)

**What changed.** This change shipped in 0.4.21 and remains the public contract for 0.5. Pre-0.4.21, connection failures, timeouts, and rejected fetches set the store value to `{ error: RpcError }`, replacing whatever data was there. Patterns like `($store ?? []).filter(...)` crashed with `TypeError` because the error object is truthy but not an array.

The store value now always holds your data type (or `undefined` while loading). Errors are surfaced on a separate `.error` `Readable<RpcError | null>`, and `.status` is a `Readable<'loading' | 'connected' | 'reconnecting' | 'error'>`.

**How to migrate.**

```diff
- {#if $messages?.error}
-   <p>{$messages.error.message}</p>
+ const err = messages.error;
+ {#if $err}
+   <p>{$err.message}</p>
```

Code that uses `$store === undefined` for loading and otherwise treats the value as data needs no changes.

### Auto-replay routing for `live.stream({ replay: true })` -- bespoke `wrapWithReplay` proxies must opt out via `WRAPPED_FOR_REPLAY` or be dropped

**What changed.** Pre-fix, the user was responsible for wrapping the platform with a `wrapWithReplay` proxy at every seam (`createMessage({ platform: wrapWithReplay })` AND `setCronPlatform(wrapWithReplay(platform))`). The docs showed the wrap only on the RPC seam, so cron-published events to a `replay: true` topic silently bypassed the buffer; reconnecting clients never saw missed cron ticks even when the documented three-tier reconnect (`replay -> delta.fromSeq -> rehydrate`) was correctly declared on the stream.

The fix moves replay routing into the framework. `live.stream(topic, loader, { replay: true })` registers the topic at declaration time (or at first-subscribe time for dynamic topic factories). When `platform.replay` is exposed by the adapter, the framework auto-routes every publish to a registered topic through `platform.replay.publish(...)` -- regardless of which seam the publisher sits on. Cron auto-publish, `ctx.publish` from RPC handlers, `ctx.publish` from cron handlers, all flow through the same routing helper. The buffer is populated end-to-end with no user wiring beyond `replay: true`.

**This is observable for two user shapes:**

1. **Apps without a custom `wrapWithReplay` proxy:** the framework now Just Works. Cron-published events to replay-eligible topics get buffered automatically; reconnecting clients see missed events on resume. No action required; this fixes the silent bug.

2. **Apps with a custom `wrapWithReplay` proxy:** the framework's auto-routing runs alongside the user proxy's routing and DOUBLE-WRITES to Redis. To preserve old behavior, mark the proxy with `[WRAPPED_FOR_REPLAY] = true` so the framework defers entirely:

   ```js
   import { WRAPPED_FOR_REPLAY } from 'svelte-realtime/server';

   function wrapWithReplay(p) {
       const wrapped = new Proxy(p, { /* ...your intercepts... */ });
       wrapped[WRAPPED_FOR_REPLAY] = true; // explicit opt-out
       return wrapped;
   }
   ```

   Or drop the wrap entirely (recommended -- the framework now owns the same job). Most bespoke `wrapWithReplay` proxies were doing exactly what the framework now does built-in: matching topics against a regex and routing to `replay.publish`. The framework's registry-from-declaration approach is more precise (topics are sourced from `live.stream({ replay: true })`, not regex patterns) and removes the asymmetry between seams.

**Dev-mode misconfiguration warning.** If `replay: true` is declared on a stream but `platform.replay` is undefined when the first publish to that topic happens, the framework logs a one-time `console.warn` per topic with the install pointer for the replay extension. Catches the "I declared `replay: true` but never installed the extension" footgun loudly. Production runs silently.

**How to migrate.**

- Most apps: do nothing. Cron + RPC + derived publishes to `replay: true` topics now reach the buffer automatically.
- Apps with a custom `wrapWithReplay` proxy: add `[WRAPPED_FOR_REPLAY] = true` to keep the proxy authoritative, OR drop the proxy and let the framework own routing.
- Apps that wired cron-side replay separately via `setCronPlatform(wrapWithReplay(platform))`: drop the cron-side wrap. The framework now routes cron auto-publishes through replay automatically. Bus wrapping still needs `configureCron({ bus })` for cluster fan-out (orthogonal concern).

### `live.upload` aggregate pre-handler buffer cap raised; chunk-0 frames may be rejected with `OVERLOADED`

**What changed.** Pre-fix, every concurrent upload stream got its own 16 MB pre-handler-resolution buffer with no aggregate cap. N concurrent connections opening streamId 0 with a 16 MB chunk-0 payload each could allocate `16 * N` MB of worker memory before any handler-side cap could fire. The default aggregate cap is now 64 MB across all in-flight pending uploads; chunk-0 frames that would exceed are rejected with `OVERLOADED` and the streamId is never registered.

**How to migrate.** No action required for normal traffic. If you orchestrate many concurrent uploads (batch import, parallel media transcode), surface the `OVERLOADED` code to the client and either retry with backoff or queue uploads. The cap is tunable via `_setCapsForTest({ uploadPendingMaxAggregate: bytes })` for tests; a runtime option is a follow-up.

### Global middleware `next()` is single-call-guarded

**What changed.** Pre-fix, a buggy middleware written as `next().then(() => next())` re-entered the chain and executed the downstream handler twice. Side-effecting handlers (charge customer, send email, increment counter) silently doubled. Each middleware frame in `_runWithMiddleware` now creates its own one-shot `next()`. The second call throws `Error('middleware: next() called more than once. ...')`.

**How to migrate.** If your middleware was buggy (calling `next()` twice), the throw lands inside your middleware function (typically caught by the surrounding RPC error handler). Fix the bug; the call now fails loud rather than silently doubling.

### `live.push` rejects with structured `LiveError` codes (not message-substring sniffing)

**What changed.** Pre-fix, callers had to sniff `err.message.includes('timed out')` to distinguish deadline expiry from other failures. Deadline expiry from the adapter primitive (`Error('request timed out')`) is now translated to `LiveError('TIMEOUT', ...)`; argument-validation throws lift from plain `Error` to `LiveError('VALIDATION', ...)`. Message text is preserved verbatim on `.message` (so existing substring checks keep working) and the original error rides on `.cause`.

The full `live.push` failure surface now discriminates via `err.code`: `VALIDATION` / `NOT_FOUND` / `TIMEOUT` / `CONNECTION_CLOSED` / caller-defined.

**How to migrate.** Replace `err.message.includes('timed out')` with `err.code === 'TIMEOUT'`. The substring check still works during the transition.

### `configureCron` accepts a partial config (validation message changed)

**What changed.** Previous rule was "leader is required". Now: at least one of `leader` or `bus` must be present. The validation error message changed from `"config must include a leader field"` to `"config must include at least one of leader or bus"`.

**How to migrate.** No action required for existing `{ leader: ... }` call sites. If you parse the error message in tests, update the substring.

### Vite plugin classifies single-arity `(ctx) => topic` as static streams

**What changed.** `_isDynamicExport` previously returned true for any function-form first argument regardless of arity, so `live.stream((ctx) => 'events:' + ctx.user.id, ...)` produced a factory-shaped client stub. The stub is now arity-aware: 0-param topic-fns and 1-param ctx-only topic-fns (named `ctx` / `context` / `_ctx`, or typed as `Ctx` / `Context` / `RequestContext` / `ServerContext` / `LiveContext`) are static; everything else stays dynamic.

**How to migrate.** If your client code has `myStream(ctx.user.id).subscribe(...)` for what is now correctly classified as static, drop the call:

```diff
- $: items = $myStream(orgId);
+ $: items = $myStream;
```

Existing 1-arg-non-ctx and 2+arg topic-fns are unaffected.

### Stream reconnect backoff timing changed

**What changed (0.4.0).** Old: fixed 50-200ms random delay. New: first two attempts use 20-100ms, then exponential backoff up to 5 minutes with jitter. Observable timing difference, not an API change.

**How to migrate.** If you have tests asserting reconnect timings, update them. Production code is unaffected.

### `live.upload` chunk pacing uses `conn.bufferedAmount`

**What changed.** The client pump now checks `conn.bufferedAmount` after every chunk and pauses sends when the WS send queue exceeds a high-water mark, resuming when it drops below a low-water mark. Defaults: 4MB high-water, 1MB low-water, 50ms drain-poll interval. Configurable via `configure({ upload: { highWaterMark, lowWaterMark } })`.

**How to migrate.** No code change required. Apps that explicitly relied on unbounded queue growth (you should not be) will see paced sends.

### `MAX_PRESENCE_REF` is now an exported tunable cap (default 1,000,000)

**What changed.** The in-memory presence-ref map (`_presenceRef`) cap was an unexported `10_000` internal that bounded only refcount bookkeeping. It now backs the zero-config presence-roster fallback (presence stream init reconstructs the roster from `_presenceRef` when `platform.presence.list` isn't wired) and is exported alongside the other documented capacity caps. Default raised to 1,000,000.

Saturation behavior: entries with a pending leave timer are evicted first; if still full, the new join is dropped silently and a one-shot warning surfaces.

**How to migrate.** If you have a custom build that referenced the unexported `10_000` constant, switch to the exported `MAX_PRESENCE_REF` import. Apps that wire `platform.presence` (Redis-backed) bypass the fallback and are unaffected.

### `live.publishRateWarning` and `live.silentTopicWarning` validation throws at registration

**What changed.** Invalid `threshold` / `intervalMs` / `thresholdMs` (non-positive, non-finite, wrong type) now throw `[svelte-realtime]`-prefixed errors at registration time so misconfiguration shows up at boot rather than mid-traffic.

**How to migrate.** No action required for valid configs. Audit any dynamic config wiring that could pass `0`, `-1`, `'30s'` (string), etc.

### `live.cron` 6-field expressions and 1Hz tick

**What changed.** A leading seconds field unlocks sub-minute granularity. Once any 6-field schedule is registered, the cron tick adapts from 60s to 1Hz (sticky for the process lifetime; cleared by `_clearCron` for HMR). 5-field schedules running under the 1Hz tick fire only at second `:00` of any matching minute, so they keep their once-per-matching-minute semantics.

`live.cron` no longer fires concurrently with itself: the tick now skips a path whose previous invocation is still in flight and increments `cronCount{status: 'skipped'}`.

**How to migrate.** No action required. If you had a long-running cron job that intentionally relied on parallel invocations (you should not), the next tick is now skipped instead of running in parallel; restructure to either let the previous invocation finish or split the work into independent jobs with different paths.

---

## Recommended new patterns

Not required. Adopting these gets you the full 0.5 experience.

### Move `setCronPlatform` and `live.configurePush({ remoteRegistry })` to `init({ platform })`

**What changed.** Both functions used to be wired from `open(ws, platform)`. The recommended call site is now the adapter's `init({ platform })` lifecycle hook, which fires once per worker after the listen socket is bound and before any upgrade / open / message hook runs. This eliminates the boot-to-first-connect window where cron ticks were no-ops and `live.push` could not reach cross-instance users.

**How to migrate.** Move the calls from `open` to `init`:

```js
// hooks.ws.js
import { setCronPlatform, live, message, close, unsubscribe } from 'svelte-realtime/server';

export function init({ platform }) {
  setCronPlatform(platform);
  live.configurePush({ remoteRegistry: registry });
}

export { message, close, unsubscribe };
```

Requires `svelte-adapter-uws@^0.5.0`. The legacy `open(ws, platform)` call site continues to work as a fallback.

### `live.upload({ reauthEvery })` mid-stream re-auth

**What changed.** Pre-fix, `_startUpload` ran the module guard once at chunk-0 arrival; if the user's session was revoked mid-upload (token expiry, explicit logout, role downgrade) the upload kept running with the original auth grant. Passing `live.upload(handler, { reauthEvery: <bytes> })` re-runs the same guard against the live `ctx` every N bytes received past the last re-auth. If the guard rejects, the upload aborts with `UNAUTHENTICATED` / `FORBIDDEN` and the consumer observes the abort signal.

Default is unset (legacy behavior: guard runs once at chunk-0). The option must be opted into per upload because not every upload has a meaningful re-auth boundary.

**How to migrate.** No action required for write-once short uploads. For long-tail user uploads (multi-minute, multi-GB) where session revocation matters:

```js
export const avatar = live.upload(
  async (ctx, name, mime) => { /* ... */ },
  { reauthEvery: 16 * 1024 * 1024 } // re-auth every 16 MB
);
```

### Auto-discovery of adapter `maxPayloadLength` for upload frame sizing

**What changed.** The server piggybacks `platform.maxPayloadLength` on the first upload-response envelope per WS via a `__cap` field; the client caches the value globally and uses it as the wire frame size for subsequent uploads, subtracting envelope overhead (10 bytes on chunks 1+, `12 + argsLen` on chunk 0) per chunk internally. The first upload uses the conservative 12KB default; the second upload onwards uses the full discovered cap.

User-configured `configure({ upload: { frameSize } })` always wins over discovery, but is silently clamped down to the discovered cap with a one-time dev warn if it exceeds the adapter's limit. The framework guarantees no wire frame ever exceeds `platform.maxPayloadLength`; without this clamp the adapter would close the connection with code 1009.

**How to migrate.** No action required. If you pinned `chunkSize` to 12KB by hand, drop the override and let auto-discovery upgrade frames on adapters with `maxPayloadLength: 1MB` (the 0.5.x default).

### `configure({ upload: { chunkSize } })` renamed to `frameSize`; `chunkSize` accepted as deprecated alias

**Why the rename.** Pre-rename, the `chunkSize` knob was raw payload bytes per chunk with no clamp and no warn. A user reading "the adapter cap is 1MB" and setting `chunkSize: 1024 * 1024` was correctly following the docs and silently built frames slightly over the cap (the envelope overhead added `12 + argsLen` bytes); uWS evaluated frame size on receive and closed the connection with code 1009. The failure was silent: the client error path never fired because the connection close beat the chunk send-ack.

**What changed.**

- The knob is renamed to `frameSize` and means "max wire frame bytes," matching `platform.maxPayloadLength`'s semantic 1:1. The framework subtracts envelope overhead per chunk internally; user code does no envelope arithmetic.
- A hard ceiling clamps user input to the discovered adapter cap, with a one-time dev warn when clamping kicks in. Overflow is now structurally impossible.
- The auto path drops the old 0.9 safety factor: frame size auto-defaults to the FULL discovered cap (the safety factor was a workaround for the missing per-chunk overhead subtraction; that's now done correctly).
- `chunkSize` is accepted as a deprecated alias for `frameSize`. Existing config still works; a one-time dev warn points at the rename. Both fields take the same numeric value.
- When both `frameSize` and `chunkSize` are set, `frameSize` wins and no deprecation warn fires.

**How to migrate.**

- Existing apps with `configure({ upload: { chunkSize: N } })` keep working. To silence the deprecation warn, rename the field to `frameSize`. The numeric value passes through unchanged.
- Existing apps that set `chunkSize` to the adapter's `maxPayloadLength` (the silent-overflow case) are now correctly clamped down by the envelope overhead. Effective payload-per-chunk drops by ~12 + `argsLen` bytes (typically ~30-50 bytes); throughput change is invisible (~0.003% on a 1MB cap).
- New apps should use `frameSize`. The mental model is: "this is the wire frame budget; the framework slices payload to fit."

```js
// Before
configure({ upload: { chunkSize: 1024 * 1024 } }); // silently overflows on 1MB cap

// After
configure({ upload: { frameSize: 1024 * 1024 } }); // safe; framework subtracts envelope per chunk
```

### `RpcError` and `LiveError` SvelteKit transport (opt-in)

**What changed.** Typed errors thrown during `+page.server.js` `load()` previously arrived at `+error.svelte` as plain `Error` instances. The new `realtimeTransport()` SvelteKit transport hook (from `svelte-realtime/hooks`) auto-registers serialization for `RpcError` and `LiveError` across the SSR / client boundary so the original class with `code` intact is preserved.

This is opt-in (additive), but apps that catch `LiveError` in their error boundary by `instanceof` or `err.code` will see the previous behavior (plain Error) until they wire the transport.

**How to migrate.** Wire the transport hook from `src/hooks.js` (NOT `hooks.server.js`):

```js
// src/hooks.js
import { realtimeTransport } from 'svelte-realtime/hooks';
export const transport = realtimeTransport();
```

---

## Cosmetic

Type-only changes, deprecations, dead code removed. No action required for most apps.

### `pushHooks.close` now drains stream-subscription bookkeeping when called with `ctx`

**What changed.** Pre-0.5, `pushHooks.close` was push-only. Apps following the JSDoc-ordained `export const close = pushHooks.close;` left stream-subscription bookkeeping (`_topicWsCounts`, silent-topic watchdogs, `__onUnsubscribe` callbacks) un-drained. A 30s flurry of `silent topic` warnings fired after every page closed.

`pushHooks.close(ws, ctx)` now routes through the realtime `close` when the adapter passes `ctx` (production), so the existing JSDoc-style re-export gets the same full cleanup with no doc-ordained migration. Direct one-arg `pushHooks.close(ws)` calls (tests, custom flows) still work as push-only via a fallback branch.

**How to migrate.** Nothing required if you wired `pushHooks.close` per the JSDoc. If you wired both `pushHooks.close` AND `realtime.close` manually (composed), the calls are idempotent across both registries - no double-drain bug.

### `onCronError()` is deprecated; use `onError()`

**What changed (0.4.0).** `onError(handler)` is the global error handler for cron, effects, and derived stream errors. `onCronError` still works but delegates.

**How to migrate.**

```diff
- onCronError((err, jobName) => log.error({ err, jobName }))
+ onError((err) => log.error({ err }))
```

### Snapshot hydration for `live.aggregate` skips `__proto__` / `constructor` / `prototype`

**What changed.** Pre-fix, `Object.assign(entry.state, snapshotState)` accepted any keys present in the snapshot payload. A snapshot returned from a backend (Redis cache, JSON payload from another service) is a hostile-input boundary - a payload like `JSON.parse('{"__proto__":{"polluted":1}}')` would have stamped `polluted` on `Object.prototype`. Snapshot hydration now copies own enumerable keys via a helper that skips `__proto__`, `constructor`, and `prototype`.

**How to migrate.** No action required unless you stored values under literal keys named `__proto__` / `constructor` / `prototype` in your aggregate state (don't). Both the single-snapshot path (`live.aggregate(..., { snapshot })`) and the per-window snapshot path (`live.aggregate(..., { snapshots: { ... } })`) go through the helper.

### Realtime rate-limit identity probes `id`, `user_id`, and `userId`

**What changed.** Pre-fix, the default per-handler rate-limit identity key read only `ctx.user.id`. Apps with sessions whose shape uses Postgres-convention `user_id` or camelCase `userId` fell back to the per-connection guest bucket - defeating per-user rate limits exactly when they mattered most. `_getIdentityKey` now reads `ctx.user.id ?? ctx.user.user_id ?? ctx.user.userId`.

**How to migrate.** No action required if your session shape exposes any of the three. If your session uses a different field, override:

```js
live.rateLimit({ identity: ctx => ctx.user?.tenant_user_id, /* ... */ })
```

### Vite codegen path interpolation now JSON-quoted (RCE fix)

**What changed.** Pre-fix, the Vite plugin emitted client stubs and server-bundle registrations as `__rpc('${modulePath}/${name}')`. A filename containing a `'` could break out of the generated string literal and inject code. Every interpolation now routes through `JSON.stringify(...)`.

**How to migrate.** No action required. Regenerate the build (`vite build`); old generated bundles on disk should be discarded.

### SSR stub generation now uses the same classifier as client stubs

**What changed.** An earlier 0.5 prerelease taught the client-side classifier that single-arity ctx-only topic functions are static, but the SSR stub generator (`_generateSsrStubs`) was missed in that pass. Result: client said "static StreamStore", SSR said "factory function", and `$inbox` during SSR rendering called `factory.subscribe(...)` and crashed every affected page with `TypeError: store.subscribe is not a function`. Both paths now go through the canonical `_isDynamicExport` classifier.

**How to migrate.** No action required after upgrading to 0.5 final.

### `live.configurePush()` typings: `remoteRegistry` is now accepted, both fields are optional

**What changed.** `server.d.ts` typed `identify` as required and omitted `remoteRegistry`. The runtime accepted either field individually and rejected only when neither was present. The typed surface now mirrors that contract via a discriminated union.

**How to migrate.** TypeScript users: if you pinned to the broken types via assertions, drop them. `live.configurePush({ remoteRegistry })` and `live.configurePush({ identify })` typecheck cleanly. `live.configurePush({})` is now a compile-time error.

### Removed: dead `pipe.filter().transformEvent` field

**What changed.** `pipe.filter()` returned `{ transformInit, transformEvent }` but `pipe()` only ever consumed `transformInit`, so `transformEvent` had no runtime effect. The field is removed from `server.js` and `server.d.ts`. The README pointer for per-event projection now correctly directs to the `transform` option on `live.stream({ transform })`.

**How to migrate.** If you set `pipe.filter({ transformEvent: ... })`, the value was being silently discarded - move to `live.stream({ transform })`:

```diff
- live.stream(topic, loader, pipe(pipe.filter({ transformEvent: project })))
+ live.stream(topic, loader, { transform: project })
```

### Default in-process lock backing `live.lock` rewritten as a per-key FIFO waiter queue

**What changed.** The prior `Map<string, Promise>` chain was replaced so that `maxWaitMs` cancellations skip cancelled waiters cleanly without breaking FIFO. Behavior for existing call sites without `maxWaitMs` is identical: same FIFO, same parallelism across keys, same handler-error propagation that unblocks the next waiter.

The adapter's `lock.clear()` now rejects pending waiters with a typed `LOCK_CLEARED` error instead of leaving them hanging.

**How to migrate.** If your code calls the adapter's lock plugin directly via `lock.clear()` and ignored `clear()`-driven rejections, add a `catch`:

```diff
  await someLockedCall().catch(err => {
+   if (err.code === 'LOCK_CLEARED') return;
    throw err;
  });
```

### `__binaryRpc` accepts `ArrayBuffer | ArrayBufferView`

**What changed (0.4.0).** The TypeScript signature widened from `ArrayBuffer` to `ArrayBuffer | ArrayBufferView`. Not breaking for callers passing `ArrayBuffer`.

**How to migrate.** None required for runtime; TypeScript users may need to relax overly-narrow argument types if they were re-typing the function.
