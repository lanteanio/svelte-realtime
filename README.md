<p align="center">
  <a href="https://svelte-realtime.dev">
    <img src="https://svelte-realtime.dev/svelte_orange.png" alt="svelte-realtime" width="240" />
  </a>
</p>

<h1 align="center">svelte-realtime</h1>

<p align="center">
  Realtime RPC and reactive subscriptions for SvelteKit, built on <a href="https://github.com/lanteanio/svelte-adapter-uws">svelte-adapter-uws</a>.
</p>

<p align="center">
  <a href="https://svelte-realtime.dev">Documentation</a> · <a href="https://svelte-realtime.dev/tutorial">Tutorial</a> · <a href="https://svelte-realtime-demo.lantean.io">Live Demo</a>
</p>

---

Write server functions. Import them in components. Call them over WebSocket. No boilerplate, no manual pub/sub wiring, no protocol design.

---

## Quick start

```bash
npx svelte-realtime my-app
cd my-app
npm run dev
```

This creates a SvelteKit project with svelte-realtime fully wired: adapter, vite plugins, WebSocket hooks, and a working counter example you can open in your browser right away.

---

## Manual setup

Starting from a SvelteKit project. If you do not have one yet, run `npx sv create my-app && cd my-app && npm install` first.

### Step 1: Install everything

```bash
npm install svelte-adapter-uws svelte-realtime
npm install uNetworking/uWebSockets.js#v20.60.0
npm install -D ws
```

What each package does:
- `svelte-adapter-uws` (>=0.4.0) -- the SvelteKit adapter that runs your app on uWebSockets.js with built-in WebSocket support
- `svelte-realtime` -- this library (RPC + streams on top of the adapter)
- `uWebSockets.js` -- the native C++ HTTP/WebSocket server (installed from GitHub, not npm)
- `ws` -- dev dependency used by the adapter during `npm run dev` (not needed in production)

### Step 2: Configure the adapter

Open `svelte.config.js` and replace the default adapter:

```js
// svelte.config.js
import adapter from 'svelte-adapter-uws';

export default {
  kit: {
    adapter: adapter({ websocket: true })
  }
};
```

### Step 3: Add the Vite plugins

Open `vite.config.js` and add the adapter and realtime plugins:

```js
// vite.config.js
import { sveltekit } from '@sveltejs/kit/vite';
import uws from 'svelte-adapter-uws/vite';
import realtime from 'svelte-realtime/vite';

export default {
  plugins: [sveltekit(), uws(), realtime()]
};
```

All three plugins are required. Order does not matter.

### Step 4: Create the WebSocket hooks file

Create `src/hooks.ws.js` in your project root. This file tells the adapter how to handle WebSocket connections and messages.

```js
// src/hooks.ws.js
export { message } from 'svelte-realtime/server';

export function upgrade({ cookies }) {
  // Return user data to attach to the connection, or false to reject.
  // This runs on every new WebSocket connection.
  const session = validateSession(cookies.session_id);
  if (!session) return false;
  return { id: session.userId, name: session.name };
}
```

`message` is a ready-made hook that routes incoming WebSocket messages to your live functions. `upgrade` decides who can connect and attaches user data to the connection.

> **This file is required.** The Vite plugin will warn at startup if it finds live modules in `src/live/` but no `src/hooks.ws.js` (or `.ts`). Without it, WebSocket messages have nothing on the server side to route them, and all RPC calls will silently time out.

### Step 5: Write a server function

Create the `src/live/` directory. Every `.js` file in this directory becomes a module of callable server functions.

```js
// src/live/chat.js
import { live, LiveError } from 'svelte-realtime/server';
import { db } from '$lib/server/db';

// A plain RPC function -- clients can call this like a regular async function
export const sendMessage = live(async (ctx, text) => {
  if (!ctx.user) throw new LiveError('UNAUTHORIZED', 'Login required');

  const msg = await db.messages.insert({ userId: ctx.user.id, text });
  ctx.publish('messages', 'created', msg);
  return msg;
});

// A stream -- clients get a Svelte store with initial data + live updates
export const messages = live.stream('messages', async (ctx) => {
  return db.messages.latest(50);
}, { merge: 'crud', key: 'id', prepend: true });
```

`live()` marks a function as callable over WebSocket. The first argument is always `ctx` (context), which contains the user data from `upgrade()`, the WebSocket connection, and a `publish` function for sending events to all subscribers.

`live.stream()` creates a reactive subscription. When a client subscribes, it gets the initial data from the function, then receives live updates whenever someone publishes to that topic.

### Step 6: Use it in a component

```svelte
<!-- src/routes/chat/+page.svelte -->
<script>
  import { sendMessage, messages } from '$live/chat';
  let text = $state('');

  async function send() {
    await sendMessage(text);
    text = '';
  }
</script>

{#if $messages === undefined}
  <p>Loading...</p>
{:else}
  {#each $messages as msg (msg.id)}
    <p><b>{msg.userId}:</b> {msg.text}</p>
  {/each}
{/if}

<input bind:value={text} />
<button onclick={send}>Send</button>
```

`$live/chat` is a virtual import. The Vite plugin reads your `src/live/chat.js` file, sees which functions are wrapped in `live()` and `live.stream()`, and generates lightweight client stubs that call them over WebSocket.

- `sendMessage` becomes a regular async function on the client.
- `messages` becomes a Svelte store. It starts as `undefined` (loading), then populates with the initial data, then merges live updates as they arrive.

That is the entire setup. Run `npm run dev` and it works.

---

## How it works

```
You write:     src/live/chat.js       (server functions)
You import:    $live/chat             (auto-generated client stubs)

live()         -> RPC call over WebSocket (async function)
live.stream()  -> Svelte store with initial data + live updates
```

The `ctx` object passed to every server function contains:

| Field | Description |
|---|---|
| `ctx.user` | Whatever `upgrade()` returned (your user data) |
| `ctx.ws` | The raw WebSocket connection |
| `ctx.platform` | The adapter platform API |
| `ctx.publish` | Shorthand for `platform.publish()` |
| `ctx.cursor` | Cursor from a `loadMore()` call, or `null` |
| `ctx.requestId` | Correlation id from `platform.requestId` (per WS connection or per HTTP request); honors `X-Request-ID` |
| `ctx.throttle` | `(topic, event, data, ms)` -- publish at most once per `ms` ms |
| `ctx.debounce` | `(topic, event, data, ms)` -- publish after `ms` ms of silence |
| `ctx.signal` | `(userId, event, data)` -- point-to-point message |
| `ctx.batch` | `(messages)` -- publish multiple messages in one call via `platform.batch()` |

Note: `ctx.user` may contain adapter-injected properties (`__subscriptions`, `remoteAddress`) in addition to whatever your `upgrade()` function returned. These are stripped automatically by the adapter before broadcasting to other clients.

---

## Table of contents

**Core**
- [Getting started](#getting-started)
- [Merge strategies](#merge-strategies)
- [Connection state stores](#connection-state-stores)
- [Svelte 5 store helpers](#svelte-5-store-helpers)
- [Error handling](#error-handling)
- [Per-module auth](#per-module-auth)
- [Dynamic topics](#dynamic-topics)
- [Topic registry](#topic-registry)
- [Schema validation](#schema-validation)
- [Channels](#channels)
- [SSR hydration](#ssr-hydration)

**Client features**
- [Batching](#batching)
- [Optimistic updates](#optimistic-updates)
- [Stream pagination](#stream-pagination)
- [Undo and redo](#undo-and-redo)
- [Request deduplication](#request-deduplication)
- [Idempotency keys](#idempotency-keys)
- [Offline queue](#offline-queue)
- [Connection hooks](#connection-hooks)
- [SvelteKit transport](#sveltekit-transport)
- [Combine stores](#combine-stores)

**Server features**
- [Global middleware](#global-middleware)
- [Throttle and debounce](#throttle-and-debounce)
- [Stream lifecycle hooks](#stream-lifecycle-hooks)
- [Access control](#access-control)
- [Rate limiting](#rate-limiting)
- [Load shedding](#load-shedding)
- [Concurrency control](#concurrency-control)
- [Server-initiated push](#server-initiated-push)
- [Request correlation](#request-correlation)
- [Cron scheduling](#cron-scheduling)
- [Derived streams](#derived-streams)
- [Effects](#effects)
- [Aggregates](#aggregates)
- [Gates](#gates)
- [Pipes](#pipes)
- [Binary RPC](#binary-rpc)
- [Rooms](#rooms)
- [Webhooks](#webhooks)
- [Signals](#signals)
- [Schema evolution](#schema-evolution)
- [Delta sync and replay](#delta-sync-and-replay)

**Deployment**
- [Redis multi-instance](#redis-multi-instance)
- [Postgres NOTIFY](#postgres-notify)
- [Clustering](#clustering)
- [Limits and gotchas](#limits-and-gotchas)

**Reference**
- [Error reporting](#error-reporting)
- [Custom message handling](#custom-message-handling)
- [DevTools](#devtools)
- [Testing](#testing)
- [Server API reference](#server-api-reference)
- [Client API reference](#client-api-reference)
- [Vite plugin options](#vite-plugin-options)
- [Benchmarks](#benchmarks)

---

## Merge strategies

The `merge` option on `live.stream()` controls how live pub/sub events are applied to the store.

### crud (default)

Handles `created`, `updated`, `deleted` events. The store maintains an array, keyed by `id` (configurable with `key`). Set `max` to cap the buffer size and drop the oldest items when exceeded (useful for live feeds with `prepend: true`).

```js
// Server
export const todos = live.stream('todos', async (ctx) => {
  return db.todos.all();
}, { merge: 'crud', key: 'id' });

export const addTodo = live(async (ctx, text) => {
  const todo = await db.todos.insert({ text });
  ctx.publish('todos', 'created', todo);
  return todo;
});
```

```svelte
<!-- Client -->
<script>
  import { todos, addTodo } from '$live/todos';
</script>

{#each $todos as todo (todo.id)}
  <p>{todo.text}</p>
{/each}
```

### latest

Ring buffer of the last N events. Good for activity feeds and logs.

```js
export const activity = live.stream('activity', async (ctx) => {
  return db.activity.recent(100);
}, { merge: 'latest', max: 100 });
```

### set

Replaces the entire value. Good for counters, status indicators, and aggregated data.

```js
export const stats = live.stream('stats', async (ctx) => {
  return { users: 42, messages: 1337 };
}, { merge: 'set' });
```

### presence

Tracks connected users with `join` and `leave` events. Items are keyed by `.key`.

```js
export const presence = live.stream(
  (ctx, roomId) => 'presence:' + roomId,
  async (ctx, roomId) => [],
  { merge: 'presence' }
);

export const join = live(async (ctx, roomId) => {
  ctx.publish('presence:' + roomId, 'join', { key: ctx.user.id, name: ctx.user.name });
});
```

```svelte
<script>
  import { presence } from '$live/room';
  const users = presence(data.roomId);
</script>

{#each $users as user (user.key)}
  <span>{user.name}</span>
{/each}
```

Events: `join` (add/update by key), `leave` (remove by key), `set` (replace all).

### cursor

Tracks cursor positions with `update` and `remove` events. Items are keyed by `.key`.

```js
export const cursors = live.stream(
  (ctx, docId) => 'cursors:' + docId,
  async (ctx, docId) => [],
  { merge: 'cursor' }
);

export const moveCursor = live(async (ctx, docId, x, y) => {
  ctx.publish('cursors:' + docId, 'update', { key: ctx.user.id, x, y, color: ctx.user.color });
});
```

Events: `update` (add/update by key), `remove` (remove by key), `set` (replace all).

### Stream options reference

| Option | Default | Description |
|---|---|---|
| `merge` | `'crud'` | Merge strategy: `'crud'`, `'latest'`, `'set'`, `'presence'`, `'cursor'` |
| `key` | `'id'` | Key field for `crud` mode |
| `prepend` | `false` | Prepend new items instead of appending (`crud` mode) |
| `max` | `50` / `0` | Max items to keep. Defaults to 50 for `latest`, 0 (unlimited) for `crud`. Oldest items are dropped when exceeded |
| `replay` | `false` | Enable seq-based replay for gap-free reconnection |
| `args` | -- | Standard Schema (Zod / ArkType / Valibot) for stream arguments. Validated before topic resolution -- prevents topic injection via malformed dynamic-topic args |
| `transform` | -- | `(data) => projection` applied to BOTH initial-load data (per-item for arrays) AND every live publish for this topic. Ship a wide row from the database, emit a narrow shape on the wire |
| `coalesceBy` | -- | `(data) => key` extractor. Publishes fan out via per-socket `sendCoalesced`; the latest value for each `(topic, key)` pair wins. For high-frequency latest-value streams (prices, cursors, presence). Cannot combine with `volatile` |
| `volatile` | `false` | Mark messages fire-and-forget. Disables seq stamping for this topic so reconnects with `lastSeenSeq` won't try to backfill. Wire-level drop-on-backpressure is the adapter's default. For typing indicators, telemetry pings, cursors |
| `staleAfterMs` | -- | Per-topic staleness watchdog. If no events arrive for N ms, the loader re-runs and the result broadcasts as a `refreshed` event. Useful for streams whose source can quietly stop emitting. See [Stream lifecycle hooks](#stream-lifecycle-hooks) |
| `invalidateOn` | -- | String or array of glob-style topic patterns (e.g. `'todos:*'`). When `ctx.publish` hits a matching topic, the stream's loader reruns and the result broadcasts as a `refreshed` event. See [Stream lifecycle hooks](#stream-lifecycle-hooks) |
| `onError` | -- | `(err, ctx, topic)` per-stream observer. Fires on loader throws (subscribe / stale-reload / `.load()` SSR). Errors thrown inside are silently swallowed |
| `classOfService` | -- | Names a class registered via `live.admission()`. New subscribes are shed under matching pressure. See [Load shedding](#load-shedding) |
| `onSubscribe` | -- | Callback `(ctx, topic)` fired when a client subscribes |
| `onUnsubscribe` | -- | Callback `(ctx, topic, remainingSubscribers)` fired when a client disconnects. `remainingSubscribers` counts OTHER WebSockets still on the topic -- use it to tear down upstream feeds at zero |
| `filter` / `access` | -- | Per-connection publish filter (see [Access control](#access-control)) |
| `delta` | -- | Delta sync config (see [Delta sync and replay](#delta-sync-and-replay)) |
| `version` | -- | Schema version (see [Schema evolution](#schema-evolution)) |
| `migrate` | -- | Migration functions (see [Schema evolution](#schema-evolution)) |

### Reconnection

When the WebSocket reconnects, streams automatically refetch initial data and resubscribe. The store keeps showing stale data during the refetch -- it does not reset to `undefined`.

---

## Connection state stores

Four reactive stores re-export from `svelte-realtime/client` for rendering connection state without app-side WebSocket plumbing.

```svelte
<script>
  import { status, failure, quiescent, health } from 'svelte-realtime/client';
</script>

{#if $health === 'degraded'}
  <Banner severity="warn">Real-time updates paused, reconnecting...</Banner>
{:else if $failure?.class === 'TERMINAL'}
  <Banner severity="error">Session expired. <a href="/login">Sign in again</a></Banner>
{:else if $failure?.class === 'THROTTLE'}
  <Banner severity="warn">Server is busy. Reconnecting more slowly...</Banner>
{:else if $status === 'disconnected'}
  <Banner severity="info">Reconnecting...</Banner>
{/if}

{#if !$quiescent}
  <Spinner />
{/if}
```

| Store | Type | Behavior |
|---|---|---|
| `status` | `'connecting' \| 'open' \| 'suspended' \| 'disconnected' \| 'failed'` | Connection state machine. `suspended` = tab in background; `failed` = terminal (auth denied or `close()` called) |
| `failure` | `{ kind, class, code, reason } \| null` | Cause of the most recent non-open transition. `class` is `TERMINAL` (auth) / `EXHAUSTED` (max retries) / `THROTTLE` (4429) / `RETRY` / `AUTH` (HTTP preflight). Cleared on next `'open'`. Not set on intentional `close()` |
| `quiescent` | `Readable<boolean>` | `true` when every active stream has settled (initial load + all reconnects). Continuous signal -- a `false -> true` transition after a reconnect cycle marks "everything caught up" |
| `health` | `'healthy' \| 'degraded'` | System-wide health, sourced from `degraded` / `recovered` events on the `__realtime` topic. Stays `'healthy'` until something publishes -- typically the extensions package's pub/sub bus circuit breaker |

`failure` and `quiescent` are pure additions; apps that don't use them pay nothing. `health` lazily subscribes to `__realtime` only on first read; never reading it = no subscription.

Apps that need richer health detail (reason strings, timestamps) can listen to the topic directly:

```js
import { on } from 'svelte-adapter-uws/client';
on('__realtime').subscribe((envelope) => { /* full payload */ });
```

---

## Svelte 5 store helpers

Generated `$live/*` stream stores work out of the box as Svelte 4 `Readable<T>` values via the `$store` auto-subscribe syntax. For Svelte 5 apps, two methods are exposed alongside the existing `subscribe` interface so component code stays terse without reaching for `$derived.by(() => $store ?? [])` boilerplate.

### `store.rune()` -- Svelte 5 reactive object

Returns an object with a single `current` getter, backed by Svelte's `fromStore` from `svelte/store`. Reading `current` inside an effect or component subscribes via Svelte's `createSubscriber` for fine-grained reactivity; reading it outside an effect synchronously returns the latest value.

```svelte
<script>
  import { todos } from '$live/todos';
  const items = todos.rune();
</script>

<p>{items.current?.length ?? 0} items</p>
{#each items.current ?? [] as todo}
  <li>{todo.title}</li>
{/each}
```

`rune()` requires Svelte 5 (the `fromStore` export is not available in Svelte 4) and throws a descriptive error if called against an older runtime. Apps still on Svelte 4 use the `$store` auto-subscribe syntax instead.

### `store.map(fn)` -- per-item projection

Returns a mapped store with the same `{ subscribe, rune, map }` shape as the source. Idiomatic alternative to `$derived.by(() => ($stream ?? []).map(...))` and avoids the `$derived(() => ...)` footgun where storing a function reference instead of its return value silently breaks rendering.

```svelte
<script>
  import { todos } from '$live/todos';
  const titles = todos.map(t => t.title);
  // Or compose with rune() for Svelte 5:
  const titlesRune = todos.map(t => t.title).rune();
</script>

{#each $titles as title}<li>{title}</li>{/each}
```

Semantics match the documented `($stream ?? []).map(fn)` pattern: a `null` or `undefined` source emits `[]`; an array source emits `source.map(fn)`; a non-array source (set-merge stream, paginated wrapper) emits `[]` after a dev-mode `console.warn` pointing at the merge-strategy docs. Subscriptions are lazy: the source is only subscribed while at least one mapped consumer is active. Chains via further `.map()` calls preserve the same shape.

### `empty` -- bundled placeholder store

Every generated `$live/<name>.js` re-exports an `empty` store that holds `undefined`. Use it as the fallback for conditional streams without importing `readable` from `svelte/store`:

```svelte
<script>
  import { todos, empty } from '$live/todos';
  let { user, orgId } = $props();
  const items = $derived(user ? todos(orgId) : empty);
</script>

{#each $items ?? [] as todo}
  <li>{todo.title}</li>
{/each}
```

Auto-imported alongside the stream itself; nothing extra to wire.

---

## Error handling

The data store value never changes shape. It is always your data type or `undefined` while loading. Errors and connection status live on separate reactive stores so a network failure can never crash your UI:

| Property | Type | Description |
|---|---|---|
| `$store` | `T \| undefined` | Your data. Never replaced by an error object. On failure, the last loaded value is preserved. |
| `store.error` | `Readable<RpcError \| null>` | Current error, or `null` when healthy. |
| `store.status` | `Readable<'loading' \| 'connected' \| 'reconnecting' \| 'error'>` | Connection status. |

Handle loading in your template:

```svelte
{#if $messages === undefined}
  <p>Loading...</p>
{:else}
  {#each $messages as msg (msg.id)}
    <p>{msg.text}</p>
  {/each}
{/if}
```

To show errors, subscribe to the `.error` store:

```svelte
<script>
  import { messages } from '$live/chat';

  const err = messages.error;
  const status = messages.status;
</script>

{#if $err}
  <p>Error: {$err.message} ({$err.code})</p>
{/if}

{#if $status === 'reconnecting'}
  <p>Reconnecting...</p>
{/if}
```

Defensive patterns like `($store ?? []).filter(...)` work correctly because `$store` is always an array or `undefined`.

For RPC calls, errors are thrown as `RpcError` with a `code` field:

```js
import { sendMessage } from '$live/chat';

try {
  await sendMessage(text);
} catch (err) {
  if (err.code === 'VALIDATION') {
    // handle validation error -- err.issues has details
  } else if (err.code === 'UNAUTHORIZED') {
    // redirect to login
  }
}
```

### Terminal close codes

When the adapter's `ready()` promise rejects (terminal close codes 1008, 4401, 4403, exhausted retries, or explicit `close()`), svelte-realtime:

- Rejects all pending RPCs immediately with `RpcError('CONNECTION_CLOSED', ...)`
- Sets `.error` on all active stream stores (the data value is preserved)
- Drains the offline queue with errors

RPCs called after a terminal close reject immediately without sending.

### Reusable error boundary component

For Svelte 5, you can build a reusable boundary that handles loading and error states:

```svelte
<!-- src/lib/StreamView.svelte -->
<script>
  /** @type {{ store: any, children: import('svelte').Snippet, loading?: import('svelte').Snippet, error?: import('svelte').Snippet<[any]> }} */
  let { store, children, loading, error } = $props();

  let value = $derived($store);
  const err = store.error;
</script>

{#if value === undefined}
  {#if loading}
    {@render loading()}
  {:else}
    <p>Loading...</p>
  {/if}
{:else if $err}
  {#if error}
    {@render error($err)}
  {:else}
    <p>Error: {$err.message}</p>
  {/if}
{:else}
  {@render children()}
{/if}
```

Use it to wrap any stream:

```svelte
<script>
  import StreamView from '$lib/StreamView.svelte';
  import { messages, sendMessage } from '$live/chat';
</script>

<StreamView store={messages}>
  {#each $messages as msg (msg.id)}
    <p>{msg.text}</p>
  {/each}

  {#snippet loading()}
    <div class="skeleton-loader">Loading messages...</div>
  {/snippet}

  {#snippet error(err)}
    <div class="error-banner">
      <p>Could not load messages: {err.message}</p>
      <button onclick={() => location.reload()}>Retry</button>
    </div>
  {/snippet}
</StreamView>
```

With default slots, the minimal version is just:

```svelte
<StreamView store={messages}>
  {#each $messages as msg (msg.id)}
    <p>{msg.text}</p>
  {/each}
</StreamView>
```

This removes the `{#if}/{:else}` boilerplate from every page that uses a stream.

---

## Per-module auth

Every file in `src/live/` can export a `_guard` that runs before all functions in that file.

```js
// src/live/admin.js
import { live, guard, LiveError } from 'svelte-realtime/server';

export const _guard = guard((ctx) => {
  if (ctx.user?.role !== 'admin')
    throw new LiveError('FORBIDDEN', 'Admin only');
});

export const deleteUser = live(async (ctx, userId) => {
  await db.users.delete(userId);
});

export const banUser = live(async (ctx, userId) => {
  await db.users.ban(userId);
});
```

Both `deleteUser` and `banUser` require admin access. No need to check in each function.

`guard()` accepts multiple functions for composable middleware chains. They run in order, and earlier ones can enrich `ctx` for later ones:

```js
export const _guard = guard(
  (ctx) => { if (!ctx.user) throw new LiveError('UNAUTHORIZED'); },
  (ctx) => { ctx.permissions = lookupPermissions(ctx.user.id); },
  (ctx) => { if (!ctx.permissions.includes('write')) throw new LiveError('FORBIDDEN'); }
);
```

---

## Dynamic topics

Use a function instead of a string as the first argument to `live.stream()` for per-entity streams. The client-side stub becomes a factory function -- call it with arguments to get a cached store for that entity.

```js
// src/live/rooms.js
import { live } from 'svelte-realtime/server';

export const roomMessages = live.stream(
  (ctx, roomId) => 'chat:' + roomId,
  async (ctx, roomId) => db.messages.forRoom(roomId),
  { merge: 'crud', key: 'id' }
);

export const sendToRoom = live(async (ctx, roomId, text) => {
  const msg = await db.messages.insert({ roomId, userId: ctx.user.id, text });
  ctx.publish('chat:' + roomId, 'created', msg);
  return msg;
});
```

```svelte
<!-- src/routes/rooms/[id]/+page.svelte -->
<script>
  import { roomMessages, sendToRoom } from '$live/rooms';
  let { data } = $props();

  // roomMessages is a function -- call it with the room ID to get a store
  const messages = roomMessages(data.roomId);
</script>

{#each $messages as msg (msg.id)}
  <p>{msg.text}</p>
{/each}
```

Same arguments return the same cached store instance. The cache is cleaned up when all subscribers unsubscribe.

---

## Topic registry

Centralize topic strings so the SQL trigger and the stream definition reference one source of truth. `defineTopics(map)` validates the map at boot and exposes `__patterns` for tooling.

```js
// src/lib/topics.js
import { defineTopics } from 'svelte-realtime/server';

export const TOPICS = defineTopics({
  audit: (orgId) => `audit:${orgId}`,
  security: (orgId) => `security:${orgId}`,
  systemNotices: 'system:notices'
});

// Stream definitions reference the registry
live.stream((ctx, orgId) => TOPICS.audit(orgId), loadAudit, { merge: 'crud' });

// Tooling reads __patterns to derive shapes
TOPICS.__patterns;
// => { audit: 'audit:{arg0}', security: 'security:{arg0}', systemNotices: 'system:notices' }
```

Map values can be strings (static topics) or `(...args) => string` functions (dynamic topics). The helper validates non-empty strings and rejects reserved names (`__patterns`, `__definedTopics`). Pattern derivation calls each function with sentinel placeholders (`{arg0}`, `{arg1}`, ...) and falls back to `'<dynamic>'` if the function throws on placeholders or returns a non-string.

### Build-time registry check

When the Vite plugin sees a `defineTopics({...})` call anywhere under `src/`, it builds a registry of patterns and validates string-literal topics passed to `live.stream(...)` and `live.channel(...)` against it. A literal that does not match any registered pattern triggers a one-shot warning per `(file, topic)` pair:

```
[svelte-realtime] src/live/feed.js: live.stream topic 'mistyped-topic' is not in
your TOPICS registry. Either add it to defineTopics({...}) or call TOPICS.<name>(...)
instead of passing a string literal.
```

The check covers static-string patterns (`feed: 'feed:notices'`) and arrow-return template literals (`audit: (orgId) => \`audit:${orgId}\``); template interpolations match `.+` so `'audit:org-123'` and `'audit:any-id'` both pass against the `audit` pattern. Function references and other dynamic value shapes are silently skipped at parse time -- the warning only fires for literal topics under a confidently parsed registry. If your project does not call `defineTopics` at all, the check is disabled.

---

## Schema validation

Use `live.validated(schema, fn)` to validate the first argument against a schema before the function runs. Any [Standard Schema](https://standardschema.dev/)-compatible validator is supported, including Zod, ArkType, Valibot, and others.

```js
import { z } from 'zod';
import { live } from 'svelte-realtime/server';

const CreateTodo = z.object({
  text: z.string().min(1).max(200),
  priority: z.enum(['low', 'medium', 'high']).optional()
});

export const addTodo = live.validated(CreateTodo, async (ctx, input) => {
  const todo = await db.todos.insert({ ...input, userId: ctx.user.id });
  ctx.publish('todos', 'created', todo);
  return todo;
});
```

Because `live.validated()` uses the [Standard Schema](https://standardschema.dev/) interface, you can swap in any compatible validator:

```js
import { type } from 'arktype';
import { live } from 'svelte-realtime/server';

const CreateTodo = type({ text: 'string>0', priority: '"low"|"medium"|"high"|undefined' });

export const addTodo = live.validated(CreateTodo, async (ctx, input) => {
  const todo = await db.todos.insert({ ...input, userId: ctx.user.id });
  ctx.publish('todos', 'created', todo);
  return todo;
});
```

On the client, validated exports work like regular `live()` calls. Validation errors are thrown as `RpcError` with `code: 'VALIDATION'` and an `issues` array.

### Validating stream arguments

Stream arguments validate via the `args` option on `live.stream()`. Validation runs BEFORE topic resolution, so a malformed argument can never reach a dynamic topic function.

```js
import { z } from 'zod';

export const auditFeed = live.stream(
  (ctx, orgId) => `audit:${orgId}`,
  async (ctx, orgId) => loadAudit(orgId),
  { args: z.tuple([z.string().uuid()]) }
);
```

Validation failures reject the subscribe RPC with `{ code: 'VALIDATION', issues }`. Both the WebSocket and `.load()` SSR paths apply the schema. Coerced values from the schema (e.g. Zod transforms) flow through to the loader and the topic function.

---

## Channels

Ephemeral pub/sub topics with no database initialization. Clients subscribe and receive live events immediately.

```js
// src/live/typing.js
import { live } from 'svelte-realtime/server';

export const typing = live.channel('typing:lobby', { merge: 'presence' });
```

```svelte
<script>
  import { typing } from '$live/typing';
</script>

{#each $typing as user (user.key)}
  <span>{user.data.name} is typing...</span>
{/each}
```

Dynamic channels work the same way:

```js
export const cursors = live.channel(
  (ctx, docId) => 'cursors:' + docId,
  { merge: 'cursor' }
);
```

For high-frequency streams where a missed frame is acceptable (typing indicators, telemetry pings, raw cursor positions you don't need replayed on reconnect), set `volatile: true` on the stream:

```js
export const cursors = live.stream(
  (ctx, roomId) => `room:${roomId}:cursors`,
  loader,
  { merge: 'cursor', volatile: true }
);
```

Two effects: per-event seq stamping is skipped for the topic (so reconnect with `lastSeenSeq` won't try to backfill), and the option declares intent at the call site. Wire-level "drop on backpressure" is the adapter's default behavior already -- uWS auto-skips a subscriber whose outbound buffer is over `maxBackpressure` (default 64 KB). Cannot combine with `coalesceBy` (queue vs drop -- different intents) or `replay` (volatile messages aren't buffered for resume).

---

## SSR hydration

Call live functions from `+page.server.js` to load data server-side, then hydrate the client-side stream store to avoid loading spinners.

```js
// src/routes/chat/+page.server.js
export async function load({ platform, locals }) {
  const { messages } = await import('$live/chat');
  const data = await messages.load(platform, { user: locals.user });
  return { messages: data };
}
```

```svelte
<!-- src/routes/chat/+page.svelte -->
<script>
  import { messages } from '$live/chat';
  let { data } = $props();

  // Pre-populate the store with SSR data -- no loading spinner
  const msgs = messages.hydrate(data.messages);
</script>

{#each $msgs as msg (msg.id)}
  <p>{msg.text}</p>
{/each}
```

The hydrated store still subscribes for live updates on first render. It keeps the SSR data visible instead of showing `undefined` during the initial fetch. Guards still run during `.load()` calls. Pass `{ user }` as the second argument if your guard or init function needs user data.

For dynamic streams (streams with a topic function), call the stream first to get the store, then hydrate:

```js
// src/routes/team/[id]/+page.server.js
export async function load({ platform, locals, params }) {
  const { invitations } = await import('$live/invitation');
  const data = await invitations.load(platform, { args: [params.id], user: locals.user });
  return { invitations: data };
}
```

```svelte
<!-- src/routes/team/[id]/+page.svelte -->
<script>
  import { invitations } from '$live/invitation';
  import { page } from '$app/state';
  let { data } = $props();

  const invites = invitations(page.params.id).hydrate(data.invitations);
</script>

{#each $invites as invite (invite.id)}
  <p>{invite.email}</p>
{/each}
```

---

## Batching

Group multiple RPC calls into a single WebSocket frame to reduce round trips.

```svelte
<script>
  import { batch } from 'svelte-realtime/client';
  import { createBoard, addColumn, addCard } from '$live/boards';

  async function setupBoard() {
    const [board, column, card] = await batch(() => [
      createBoard('My Board'),
      addColumn('To Do'),
      addCard('First task')
    ]);
  }
</script>
```

By default, calls in a batch run in parallel on the server. Pass `{ sequential: true }` when order matters:

```js
const [board, column] = await batch(() => [
  createBoard('My Board'),
  addColumn(boardId, 'To Do')
], { sequential: true });
```

Each call resolves or rejects independently -- one failure does not cancel the others. Batches are limited to 50 calls -- enforced both client-side (rejects before sending) and server-side.

### Server-side batching

Use `ctx.batch()` inside RPC handlers to publish multiple messages in a single call:

```js
export const resetBoard = live(async (ctx, boardId) => {
  await db.boards.reset(boardId);
  ctx.batch([
    { topic: `board:${boardId}`, event: 'set', data: [] },
    { topic: `board:${boardId}:presence`, event: 'set', data: [] }
  ]);
});
```

---

## Optimistic updates

Apply changes to a stream store instantly, then roll back if the server call fails.

```svelte
<script>
  import { todos, addTodo } from '$live/todos';

  async function add(text) {
    const tempId = 'temp-' + Date.now();
    const rollback = todos.optimistic('created', { id: tempId, text });

    try {
      await addTodo(text);
      // Server broadcasts the real 'created' event, which replaces the
      // optimistic entry (matched by key) with the confirmed data.
    } catch {
      rollback();
    }
  }
</script>
```

`optimistic(event, data)` returns a rollback function that restores the store to its previous state. It works with all merge strategies:

| Merge | Events | Behavior |
|---|---|---|
| `crud` | `created`, `updated`, `deleted` | Modifies array by key. Server event with same key replaces the optimistic entry. |
| `latest` | any event name | Appends data to the ring buffer. |
| `set` | any event name | Replaces the entire value. |

### Auto-rollback with `store.mutate()`

`store.mutate(asyncOp, optimisticChange)` wraps the apply-await-rollback pattern. Applies the optimistic change synchronously, awaits the RPC, and on rejection restores the snapshot and re-throws.

```js
// Event-based: server's confirming event reconciles the placeholder by key
const todo = await todos.mutate(
  () => addTodo(text),
  { event: 'created', data: { id: tempId(), text } }
);

// Free-form mutator: arbitrary local change, no merge-strategy assumptions
await todos.mutate(
  () => removeTodo(id),
  (current) => current.filter((t) => t.id !== id)
);
```

Returns the result of `asyncOp` on success. The snapshot is shallow: top-level array shape changes (push, pop, filter, splice) roll back; in-place item field mutations (`draft[0].name = 'x'`) do NOT, because the snapshot and the draft share item references. Replace whole items instead: `draft[i] = { ...draft[i], name: 'x' }`.

### RPC-bound shorthand: `rpc.createOptimistic()`

Every generated RPC stub also exposes a `.createOptimistic(store, callArgs, optimisticChange)` method. It threads `callArgs` into the optimistic-change callback so the call site doesn't have to capture them in a closure:

```js
import { sendMessage, messages } from '$live/chat';

await sendMessage.createOptimistic(
  messages,
  ['Hello!'],
  (current, args) => [...current, { id: tempId(), text: args[0] }]
);
```

`callArgs` is always passed as an array (so multi-argument RPCs work the same as single-argument ones; pass `[arg]` for the single-arg case). The third argument accepts the same two shapes as `store.mutate()`: a `(current, args) => newValue` function or a `{ event, data }` object. Equivalent to:

```js
store.mutate(() => rpc(...callArgs), wrappedChange);
```

so behavior on success/rollback/server-confirmation is identical to `store.mutate()`. The shorthand is purely syntactic; reach for `store.mutate()` directly when the asyncOp isn't an RPC (third-party API call, multi-step flow, etc.).

**Curried form** -- bind once, call many times. Pass two arguments instead of three (`store, change`) and `createOptimistic` returns a callable bound to that store + change:

```js
const optimisticSend = sendMessage.createOptimistic(
  messages,
  (current, args) => [...current, { id: tempId(), text: args[0] }]
);
await optimisticSend('Hello!');
await optimisticSend('There!');
```

**Stream-side spelling** -- the same flow can be expressed from the stream's perspective via `store.createOptimistic(rpc, callArgs, change)`:

```js
await messages.createOptimistic(
  sendMessage,
  ['Hello!'],
  (current, args) => [...current, { id: tempId(), text: args[0] }]
);
```

Identical semantics to the RPC-side spelling; pick whichever reads more naturally for your call site (stream-focused code prefers `store.createOptimistic`; RPC-focused code prefers `rpc.createOptimistic`).

---

## Stream pagination

For large datasets, return `{ data, hasMore, cursor }` from your stream init function to enable cursor-based pagination.

```js
// src/live/feed.js
import { live } from 'svelte-realtime/server';

export const posts = live.stream('posts', async (ctx) => {
  const limit = 20;
  const rows = await db.posts.list({ limit: limit + 1, after: ctx.cursor });
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = data.length > 0 ? data[data.length - 1].id : null;
  return { data, hasMore, cursor };
}, { merge: 'crud', key: 'id' });
```

```svelte
<script>
  import { posts } from '$live/feed';

  async function loadNext() {
    await posts.loadMore();
  }
</script>

{#each $posts as post (post.id)}
  <p>{post.title}</p>
{/each}

{#if posts.hasMore}
  <button onclick={loadNext}>Load more</button>
{/if}
```

The server detects the `{ data, hasMore }` shape automatically. `ctx.cursor` contains the cursor value sent by the client on subsequent `loadMore()` calls (`null` on the first request).

---

## Undo and redo

Stream stores support history tracking for undo/redo.

```svelte
<script>
  import { todos } from '$live/todos';

  todos.enableHistory(100); // max 100 entries

  function handleUndo() {
    todos.undo();
  }
</script>

<button onclick={handleUndo} disabled={!todos.canUndo}>Undo</button>
<button onclick={() => todos.redo()} disabled={!todos.canRedo}>Redo</button>
```

History is recorded after every mutation (both live events and optimistic updates). Call `enableHistory()` once to start tracking.

---

## Request deduplication

Identical RPC calls made within the same microtask are automatically coalesced into a single request.

```js
// These two calls happen in the same microtask -- only one request is sent
const [a, b] = await Promise.all([
  getUser(userId),
  getUser(userId) // same call, same args -- reuses the first request
]);
```

To bypass deduplication and force a fresh request:

```js
const result = await getUser.fresh(userId); // always sends a new request
```

---

## Idempotency keys

Microtask deduplication only collapses calls within the same tick. For durable safety against retries that span reconnects, tab reloads, or offline replay, wrap the handler with `live.idempotent(config, fn)`. Identical calls (by key) return the cached result without re-running the handler.

```js
// Server: server-derived key (Stripe-style)
import { live } from 'svelte-realtime/server';

export const createOrder = live.idempotent(
  { keyFrom: (ctx, input) => `order:${ctx.user.id}:${input.clientOrderId}`, ttl: 48 * 3600 },
  live.validated(OrderSchema, async (ctx, input) => {
    return db.orders.insert({ userId: ctx.user.id, ...input });
  })
);
```

```js
// Client: envelope-supplied key (uuid per intent)
import { createOrder } from '$live/orders';

const intentId = crypto.randomUUID();
const order = await createOrder.with({ idempotencyKey: intentId })(payload);
```

Resolution: `keyFrom(ctx, ...args)` if defined, otherwise the client envelope's `idempotencyKey`, otherwise the wrapper is a no-op. Only successful results cache; throwing handlers abort the slot so the next caller re-runs. Default store is in-process and bounded; for multi-instance deployments pass `store: createIdempotencyStore(redis)` from `svelte-adapter-uws-extensions`.

| Option | Default | Description |
|---|---|---|
| `keyFrom` | -- | `(ctx, ...args) => string \| null \| undefined`. `null`/`undefined` falls back to the envelope key |
| `store` | in-process | Any object exposing `acquire(key, ttlSec)` matching the extensions store contract |
| `ttl` | `172800` (48h) | TTL in seconds. `0` skips the cache write (concurrent waiters re-run after the first finishes) |

`__rpc().with({ ... })` composes options on the same surface:

```js
// Compose idempotency + per-call timeout
await createOrder.with({ idempotencyKey: id, timeout: 60_000 })(payload);
```

| `.with({})` option | Description |
|---|---|
| `idempotencyKey` | Carried in the envelope for the server's `live.idempotent` wrapper |
| `timeout` | Per-call timeout in ms; overrides the global `configure({ timeout })` default. Sleep-detect threshold scales with the override |

---

## Offline queue

Queue RPC calls when the WebSocket is disconnected and replay them on reconnect.

```js
import { configure } from 'svelte-realtime/client';

configure({
  offline: {
    queue: true,        // enable offline queuing
    maxQueue: 100,      // drop oldest if queue exceeds this (default: 100)
    maxAge: 60000,      // auto-reject queued calls older than this (ms)
    beforeReplay(call) {
      // Return false to drop stale mutations
      return Date.now() - call.queuedAt < 60000; // drop if older than 1 minute
    },
    onReplayError(call, error) {
      console.warn('Replay failed:', call.path, error);
    }
  }
});
```

When offline queuing is enabled, RPC calls made while disconnected return promises that resolve when the call is replayed after reconnection. If the queue overflows, the oldest entry is dropped and its promise rejects with `QUEUE_FULL`. If `maxAge` is set, queued calls older than that threshold are rejected with `STALE` at replay time.

---

## Connection hooks

Use `configure()` on the client to react to WebSocket connection state changes.

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { configure } from 'svelte-realtime/client';

  configure({
    onConnect() {
      // Reconnected after a drop
      invalidateAll();
    },
    onDisconnect() {
      showBanner('Connection lost, reconnecting...');
    }
  });
</script>
```

Call `configure()` once at app startup. The hooks fire on state transitions only (not on the initial connection).

| Option | Description |
|---|---|
| `url` | Full WebSocket URL for cross-origin or native app usage (e.g. `'wss://api.example.com/ws'`) |
| `auth` | `true` (or a custom path) to enable an HTTP preflight before each WebSocket upgrade so cookies set by the server's `authenticate` hook ride a normal HTTP response. Required behind Cloudflare Tunnel and other proxies that drop `Set-Cookie` on 101 responses. Requires `svelte-adapter-uws` >= 0.4.12. |
| `onConnect()` | Called when the WebSocket connection opens after a reconnect |
| `onDisconnect()` | Called when the WebSocket connection closes |
| `beforeReconnect()` | Called before each reconnection attempt (can be async) |

### Cross-origin and native app usage

When using svelte-realtime from a client that runs on a different origin (Svelte Native, React Native, or any standalone app), pass the `url` option to point at your SvelteKit backend:

```js
import { configure, __rpc, __stream } from 'svelte-realtime/client';

configure({ url: 'wss://my-sveltekit-app.com/ws' });

// Call a live function (equivalent to $live/chat.sendMessage, but untyped)
const sendMessage = __rpc('chat/sendMessage');
await sendMessage('hello');

// Subscribe to a stream (returns a Svelte store)
const messages = __stream('chat/messages', { merge: 'crud', key: 'id' });
messages.subscribe((value) => console.log(value));
```

The typed `$live/*` imports and stream hydration are generated by the Vite plugin and only work inside a SvelteKit project. Outside SvelteKit, use `__rpc()` and `__stream()` directly. You get the same reconnection, offline queue, and batching -- just without codegen and types.

When `url` is set, the default same-origin WebSocket URL is bypassed entirely. Requires `svelte-adapter-uws` 0.4.8+.

Browser clients authenticate via cookies set during login. Native clients typically use a token instead. Your upgrade hook can support both:

```js
// src/hooks.ws.js
export { message } from 'svelte-realtime/server';

export function upgrade({ cookies, url }) {
  // Browser -- cookie auth
  const session = cookies.session_id;
  if (session) return validateSession(session);

  // Native app -- token auth via query string
  const token = new URL(url, 'http://n').searchParams.get('token');
  if (token) return validateToken(token);

  return false;
}
```

The native client passes the token in the URL:

```js
configure({ url: 'wss://my-sveltekit-app.com/ws?token=...' });
```

### Refreshing session cookies on connect (Cloudflare Tunnel and friends)

Cloudflare Tunnel and other strict edge proxies silently drop the `Set-Cookie` header on WebSocket `101 Switching Protocols` responses. The connection appears to open server-side, then the client immediately sees `close 1006` and never receives a single frame. The classic symptom for this in production: WebSockets work locally and on a bare server, then break the moment you put Cloudflare in front.

Fix it in three pieces:

1. Export an `authenticate` hook from `src/hooks.ws.{js,ts}`. It runs as a normal HTTP `POST /__ws/auth` before every upgrade (including reconnects), so cookies you set ride a `204 No Content` response that proxies route correctly.
2. Opt into the client preflight with `configure({ auth: true })`.
3. Use `svelte-adapter-uws` >= 0.4.12.

```js
// src/hooks.ws.js
export { message, close, unsubscribe } from 'svelte-realtime/server';

export function upgrade({ cookies }) {
  const session = validateSession(cookies.session_id);
  return session ? { id: session.userId, name: session.name } : false;
}

export function authenticate({ cookies }) {
  const session = validateSession(cookies.get('session_id'));
  if (!session) return false;

  if (shouldRotate(session)) {
    cookies.set('session_id', rotate(session), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/'
    });
  }
  return { id: session.userId, name: session.name };
}
```

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { configure } from 'svelte-realtime/client';
  configure({ auth: true });
</script>
```

The client coalesces concurrent connects into a single in-flight preflight, treats `4xx` as terminal, and falls back to normal reconnect backoff on `5xx` and network errors.

> **Detector:** if the client sees two consecutive WebSocket open->close cycles inside one second with no traffic, it logs a one-shot `console.warn` pointing at this section. That is the Cloudflare-Tunnel-eating-cookies fingerprint.

---

## SvelteKit transport

`realtimeTransport()` from `svelte-realtime/hooks` is a SvelteKit transport-hook preset that auto-registers `RpcError` and `LiveError` serialization across the SSR / client boundary. Without it, typed errors thrown from `+page.server.js` `load()` arrive at `+error.svelte` as plain `Error` instances and lose their `code` field.

```js
// src/hooks.js  (NOT hooks.server.js -- the shared hook is required)
import { realtimeTransport } from 'svelte-realtime/hooks';

export const transport = realtimeTransport();
```

Compose with app-defined types via the optional `extras` parameter (user entries appear after defaults so they win on key conflict):

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

Wire from `src/hooks.js`, NOT `hooks.server.js`. SvelteKit's transport primitive needs both encode (server-side) and decode (client-side hydration) visible at build time -- the wrong file silently half-works (encode runs but decode never reaches the client). `RpcError`'s optional `issues` field (carried by `live.validated()` failures) survives the round-trip. Validation runs at registration: malformed extras throw immediately so misconfiguration fails fast at app boot.

---

## Combine stores

Compose multiple stream stores into a single derived store. When any source updates, the combining function re-runs.

```svelte
<script>
  import { combine } from 'svelte-realtime/client';
  import { orders, inventory } from '$live/dashboard';

  const dashboard = combine(orders, inventory, (o, i) => ({
    pendingOrders: o?.filter(x => x.status === 'pending').length ?? 0,
    lowStock: i?.filter(x => x.qty < 10) ?? []
  }));
</script>

<p>Pending: {$dashboard.pendingOrders}</p>
```

`combine()` accepts 2-6 stores with typed overloads, plus a variadic fallback for more. Zero network overhead -- all computation happens client-side.

---

## Global middleware

Use `live.middleware()` to register cross-cutting logic that runs before per-module guards on every RPC and stream call.

```js
import { live, LiveError } from 'svelte-realtime/server';

// Logging middleware
live.middleware(async (ctx, next) => {
  const start = Date.now();
  const result = await next();
  console.log(`[${ctx.user?.id}] took ${Date.now() - start}ms`);
  return result;
});

// Auth middleware -- rejects unauthenticated requests globally
live.middleware(async (ctx, next) => {
  if (!ctx.user) throw new LiveError('UNAUTHORIZED', 'Login required');
  return next();
});
```

Middleware runs in registration order. Each must call `next()` to continue the chain. When no middleware is registered, there is zero overhead.

---

## Throttle and debounce

Use `ctx.throttle()` and `ctx.debounce()` inside any `live()` function to rate-limit publishes.

```js
export const updatePosition = live(async (ctx, x, y) => {
  // Throttle: publishes immediately, then at most once per 50ms (trailing edge guaranteed)
  ctx.throttle('cursors', 'update', { key: ctx.user.id, x, y }, 50);
});

export const saveSearch = live(async (ctx, query) => {
  // Debounce: waits for 300ms of silence before publishing
  ctx.debounce('search:' + ctx.user.id, 'set', { query }, 300);
});
```

`ctx.throttle` publishes the first call immediately, stores subsequent calls, and sends the last value when the interval expires (trailing edge). `ctx.debounce` resets the timer on each call and only publishes after silence.

---

## Stream lifecycle hooks

Use `onSubscribe` and `onUnsubscribe` in stream options to run logic when clients join or leave a stream.

```js
export const presence = live.stream('room:lobby', async (ctx) => {
  return db.presence.list('lobby');
}, {
  merge: 'presence',
  onSubscribe(ctx, topic) {
    ctx.publish(topic, 'join', { key: ctx.user.id, name: ctx.user.name });
  },
  onUnsubscribe(ctx, topic, remainingSubscribers) {
    ctx.publish(topic, 'leave', { key: ctx.user.id });
    if (remainingSubscribers === 0) stopUpstreamFeed(topic);
  }
});
```

`onSubscribe` fires after `ws.subscribe(topic)` and the initial data fetch. `onUnsubscribe` fires in real time when a client unsubscribes from a topic (adapter 0.4.0+), and also when the WebSocket closes for any remaining topics. Export both hooks from your `hooks.ws.js`:

```js
export { message, close, unsubscribe } from 'svelte-realtime/server';
```

`onUnsubscribe` fires for both static and dynamic topics. For dynamic topics, the server tracks which stream produced each subscription and fires the correct hook. The `unsubscribe` hook fires as soon as the client drops a topic; `close` only fires for topics still active at disconnect time. There is no double-firing.

The third argument `remainingSubscribers` counts OTHER WebSockets still holding a realtime-stream subscription to the topic after the current one drops. Use it to tear down upstream feeds (CDC connections, polling loops, external pub/sub follows) when the count reaches zero. Existing 2-argument `(ctx, topic) => ...` handlers continue to work; the third arg is silently ignored.

### Staleness watchdog and per-stream `onError`

Streams whose underlying source can quietly stop emitting (CDC drops, polling stalls, upstream cache evicts the key) declare `staleAfterMs` to arm a per-topic watchdog. Every `ctx.publish` to the topic resets the timer; if no events arrive for the configured duration, the realtime layer re-runs the loader and broadcasts the result as a `refreshed` event. The client merges `refreshed` as a full-state replacement across every merge strategy.

```js
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

Watchdog state is per-topic. Multiple subscribers share one timer; the timer arms on the first subscribe and clears when the last subscriber leaves. The reload uses the first subscriber's `ctx` and `args`, which is correct for shared topics since the loader's output is identical regardless of which subscriber's ctx triggers it.

`onError(err, ctx, topic)` is observer-only. It fires on loader throws across three paths -- the initial subscribe, the staleness-driven reload, and the `.load()` SSR path. Errors thrown inside `onError` are silently swallowed so a buggy logger never breaks the original error path. Apps that want a topic-scoped degraded signal can publish a system event from inside the handler:

```js
onError: (err, ctx, topic) => {
  ctx.publish(`__system:${topic}`, 'degraded', { reason: err.message });
}
```

### Topic-driven invalidation

For mutations whose effects don't fit the merge-strategy model cleanly (bulk operations, server-side recomputation, cascading writes), declare an `invalidateOn` pattern so any matching `ctx.publish` triggers a loader rerun:

```js
export const todos = live.stream('todos', loadTodos, {
  merge: 'crud',
  invalidateOn: 'todos:*'
});

// Anywhere in your live functions:
ctx.publish('todos:bulk-imported', 'created', { count: 42 });
// -> matches 'todos:*', the todos loader reruns, the result is broadcast
//    as a 'refreshed' event, and every subscriber gets the new state.
```

`invalidateOn` accepts a single string or an array of strings. `*` is a wildcard that matches any sequence of one or more characters; other regex specials are escaped. Multiple patterns are OR-ed (any match triggers the reload).

The reload reuses the staleness machinery: it captures the first subscriber's `ctx` + args, applies any configured init `transform`, and publishes a `refreshed` event to the stream's own topic. The client merges `refreshed` as a full-state replacement.

`refreshed` events are themselves excluded from the invalidation check, so a stream whose own topic happens to match its `invalidateOn` pattern (e.g., `'todos*'` matching topic `'todos'`) won't loop. Concurrent triggers while a reload is in flight are deduped via a per-watcher `reloading` flag.

Errors thrown by the loader during an `invalidateOn` reload route through the same `onError(err, ctx, topic)` observer as staleness-driven reloads.

---

## Access control

Use the `filter` / `access` option on `live.stream()` to control who can subscribe. The predicate receives `ctx` and is checked once at subscription time. If it returns `false`, the subscription is denied with `{ ok: false, code: 'FORBIDDEN', error: 'Access denied' }` and no data is sent. For per-event filtering, use `pipe.filter()`.

```js
import { live } from 'svelte-realtime/server';

// Only admins can subscribe
export const adminFeed = live.stream('admin-feed', async (ctx) => {
  return db.adminEvents.recent();
}, {
  merge: 'crud',
  access: (ctx) => ctx.user?.role === 'admin'
});

// Role-based: different roles get different access
export const items = live.stream('items', async (ctx) => {
  return db.items.all();
}, {
  merge: 'crud',
  access: live.access.role({
    admin: true,
    viewer: false
  })
});
```

For **per-user data isolation**, use dynamic topics so each user subscribes to their own topic:

```js
// Each user gets their own topic -- no cross-user data leakage
export const myOrders = live.stream(
  (ctx) => `orders:${ctx.user.id}`,
  async (ctx) => db.orders.forUser(ctx.user.id),
  { merge: 'crud', key: 'id' }
);
```

| Helper | Description |
|---|---|
| `live.access.owner(field?)` | Subscription allowed if `ctx.user[field]` is present (default: `'id'`) |
| `live.access.team()` | Subscription allowed if `ctx.user.teamId` is present |
| `live.access.role(map)` | Role-based: `{ admin: true, viewer: (ctx) => ... }` |
| `live.access.org(opts?)` | Subscription allowed if `args[0]` matches `ctx.user.organization_id`. Configurable via `{ from, orgField }` |
| `live.access.user(opts?)` | Subscription allowed if `args[0]` matches `ctx.user.user_id`. Configurable via `{ from, userField }` |
| `live.access.any(...predicates)` | OR: any predicate returning true allows the subscription |
| `live.access.all(...predicates)` | AND: all predicates must return true |

`live.access.org` and `live.access.user` follow the SQL `[table]_id` convention. Override the field for non-default user shapes:

```js
// Stream that takes an orgId arg and verifies the caller belongs to that org
export const auditFeed = live.stream(
  (ctx, orgId) => `audit:${orgId}`,
  async (ctx, orgId) => loadAudit(orgId),
  { access: live.access.org() }
);

// Custom user-shape (e.g. SvelteKit locals.user with camelCase)
access: live.access.org({ orgField: 'organizationId' })
```

### Authentication shorthand on guards

`guard()` accepts an options object alongside the existing variadic-function shape. `{ authenticated: true }` rejects calls with no `ctx.user` as `UNAUTHENTICATED`:

```js
// src/live/_guard.js
import { guard } from 'svelte-realtime/server';

// Bare authenticated check
export const _guard = guard({ authenticated: true });

// Compose with custom predicates
export const _guard = guard({ authenticated: true }, (ctx) => ctx.user.role === 'admin');
```

Bare `Error` throws from any guard auto-classify: thrown errors against an anonymous user produce `LiveError('UNAUTHENTICATED')`; thrown errors with a user produce `LiveError('FORBIDDEN')`. Original errors travel on `.cause` for server-side logging. Throw `LiveError(code, message)` explicitly to control the wire-visible code and message verbatim.

### `live.scoped(predicate, fn)`

Wrap an RPC handler with a per-call access predicate that throws `UNAUTHENTICATED` (no user) or `FORBIDDEN` (predicate rejects). Composes with `live.validated`, `live.rateLimit`, etc.

```js
export const editOrgSettings = live.scoped(
  live.access.org(),
  live.validated(SettingsSchema, async (ctx, orgId, patch) => {
    return db.orgs.update(orgId, patch);
  })
);
```

For streams, use the `access` option directly. `live.scoped` is the RPC equivalent.

### Subscribe-denial codes on stream stores

When a server-side subscribe denial fires (guard rejection, access predicate, rate limit, invalid topic), the typed reason flows through the stream store's `error` slot as an `RpcError` with the canonical code:

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
{:else if $err}
  <p>Audit feed unavailable: {$err.message}</p>
{/if}
```

Custom denial reasons returned from a server-side `subscribe` hook (e.g. `'KYC_PENDING'`) flow through verbatim as the `code` field. The same denial fans out to every stream subscribed to the topic.

---

## Rate limiting

### Per-function rate limiting

Use `live.rateLimit()` to apply a sliding window rate limiter to a single function:

```js
export const sendMessage = live.rateLimit({ points: 5, window: 10000 }, async (ctx, text) => {
  const msg = await db.messages.insert({ userId: ctx.user.id, text });
  ctx.publish('messages', 'created', msg);
  return msg;
});
```

### Registry-level rate limiting

For the common case of "a default for everyone, with a few path overrides and a few exemptions" you can configure the registry once at startup with `live.rateLimits()`:

```js
// hooks.ws.js or any startup module
import { live } from 'svelte-realtime/server';

live.rateLimits({
  default: { points: 200, window: 10_000 },
  overrides: {
    'chat/sendMessage': { points: 50, window: 10_000 },
    'orders/create':    { points: 5,  window: 60_000 }
  },
  exempt: ['presence/moveCursor', 'cursor/move']
});
```

Resolution order per call: `exempt` -> per-handler `live.rateLimit(...)` wrapping (explicit wins over central) -> `overrides[path]` -> `default` -> none. Stream subscribes are not rate-limited by this primitive. Pass `null` to clear the registry.

### Global rate limiting with Redis

Use the `beforeExecute` hook with the rate limit extension for global per-connection throttling:

```js
import { createMessage, LiveError } from 'svelte-realtime/server';
import { createRedis, createRateLimit } from 'svelte-adapter-uws-extensions/redis';

const redis = createRedis();
const limiter = createRateLimit(redis, { points: 30, interval: 10000 });

export const message = createMessage({
  async beforeExecute(ws, rpcPath) {
    const { allowed, resetMs } = await limiter.consume(ws);
    if (!allowed)
      throw new LiveError('RATE_LIMITED', `Too many requests. Retry in ${Math.ceil(resetMs / 1000)}s`);
  }
});
```

---

## Load shedding

Under sustained pressure, drop low-priority traffic before it reaches the handler. `live.admission(config)` registers named pressure rules; `ctx.shed(className)` checks them; the `classOfService` stream option gates new subscribes automatically.

```js
import { live } from 'svelte-realtime/server';

// Register classes once at startup
live.admission({
  classes: {
    background: ['PUBLISH_RATE', 'SUBSCRIBERS', 'MEMORY'],   // shed under any pressure
    nonCritical: ['MEMORY'],                                  // shed only on memory pressure
    realtime: (snapshot) => snapshot.publishRate > 8000      // custom predicate
  }
});

// Stream gating: new subscribes shed under matching pressure
export const browseList = live.stream('browse:list', loader, {
  merge: 'crud',
  classOfService: 'background'
});

// RPC gating: per-call decision
export const expensiveSearch = live(async (ctx, query) => {
  if (ctx.shed('background')) {
    throw new LiveError('OVERLOADED', 'Server is busy, try again shortly');
  }
  return search(query);
});
```

`platform.pressure.reason` is a precedence-ordered enum (`MEMORY > PUBLISH_RATE > SUBSCRIBERS > NONE`); class rules using a string-array match if the active reason is in the array. Predicate rules receive the full pressure snapshot. Existing subscribers are unaffected -- shedding applies to NEW subscribes and RPC calls only.

`live.admission()` validates rules at registration; unknown reasons throw with a `[svelte-realtime]`-prefixed error so typos fail fast at boot. Pass `null` to clear.

---

## Concurrency control

`live.lock(keyOrConfig, fn)` serializes concurrent RPC calls that resolve to the same key. Composes with `live.validated`, `live.idempotent`, `live.rateLimit`, etc.

```js
// Per-org leaderboard recompute: one in-flight per org, others wait for the result
export const recomputeLeaderboard = live.lock(
  (ctx) => `leaderboard:${ctx.user.organization_id}`,
  async (ctx) => {
    const rows = await db.expensive.recompute(ctx.user.organization_id);
    ctx.publish(`org:${ctx.user.organization_id}:leaderboard`, 'set', rows);
    return rows;
  }
);

// Static key (single global section)
export const rebuildSearchIndex = live.lock('search-index-rebuild', async (ctx) => {
  return rebuildIndex();
});

// Distributed lock via the extensions package
import { createDistributedLock } from 'svelte-adapter-uws-extensions/redis/lock';
const distributedLock = createDistributedLock(redis);

export const settleInvoice = live.lock(
  { key: (ctx, id) => `invoice:${id}`, lock: distributedLock },
  live.validated(InvoiceIdSchema, async (ctx, id) => settle(id))
);
```

Concurrent callers wait in FIFO order for the holder's result. A `null` / `undefined` / empty key bypasses the lock (the handler runs unguarded for that call). Custom lock implementations need a single method: `withLock(key, fn) -> Promise<result>`.

Default lock is in-process and bounded. For multi-instance deployments, pass `lock: createDistributedLock(redis)` from the extensions package -- any object exposing the `withLock(key, fn)` contract works.

---

## Server-initiated push

`live.push({ userId }, event, data, options?)` sends a server-initiated request to a connected user and awaits the reply. Routes through a per-instance userId -> WebSocket registry maintained by a small pair of hooks.

```js
// hooks.ws.js -- wire the registry once
import { pushHooks } from 'svelte-realtime/server';

export const open = pushHooks.open;
export const close = pushHooks.close;
```

```js
// Anywhere on the server (admin RPC, cron, webhook receiver, etc.)
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
<!-- Client: register handlers per event -->
<script>
  import { onPush } from 'svelte-realtime/client';

  onPush('confirm-delete', async ({ itemId }) => {
    return { confirmed: confirm(`Delete item ${itemId}?`) };
  });
</script>
```

The default identifier reads `ws.getUserData()?.user_id ?? ws.getUserData()?.userId`. Override for custom userData shapes:

```js
import { live } from 'svelte-realtime/server';
live.configurePush({ identify: (ws) => ws.getUserData()?.account?.id });
```

Throws `LiveError('NOT_FOUND')` when no connection is registered for the userId. Propagates `Error('request timed out')` from the underlying primitive on the configurable `timeoutMs` (default 5000ms), and `Error('connection closed')` if the WebSocket closes before reply.

Multi-device users see most-recent-connection-wins routing within each instance, and cluster-wide most-recent-wins via the registry's Redis hash when cluster routing is configured (see [Cluster routing](#cluster-routing) below). Older connections still receive topic publishes via their own subscriptions; only push routing flips. Anonymous connections (identify returning null/undefined) are silently skipped at registration so they cannot be push targets.

`onPush(event, handler)` multiplexes multiple events over the adapter's single `onRequest` channel. Returning a value sends it as the reply; throwing rejects the server-side promise. Returns an unsubscribe function.

### Cluster routing

For multi-instance deploys, wire the connection registry from `svelte-adapter-uws-extensions` so a `live.push` originating on any instance reaches the user's owning instance:

```js
// hooks.ws.js
import { pushHooks, live } from 'svelte-realtime/server';
import { createRedisClient } from 'svelte-adapter-uws-extensions/redis';
import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry';

const redis = createRedisClient({ url: process.env.REDIS_URL });
const registry = createConnectionRegistry(redis, {
  identify: (ws) => ws.getUserData()?.userId
});

// Tell live.push to fall back to the registry for cross-instance lookups
live.configurePush({ remoteRegistry: registry });

// Wire the registry's own connection hooks (NOT pushHooks.* in this mode --
// the registry tracks ownership in Redis and short-circuits same-instance
// requests internally).
export const open = registry.hooks.open;
export const close = registry.hooks.close;
```

Lookup order inside `live.push`:

1. **Local registry** -- the per-instance Map populated by `pushHooks.open` / `pushHooks.close`. Resolves directly via `platform.request(ws, ...)` with no I/O.
2. **Remote registry** -- when configured via `live.configurePush({ remoteRegistry })`, used as a fallback when the userId is not registered locally. The extensions registry looks up the owning instance in Redis and either short-circuits to a local `platform.request` or forwards the envelope on a per-instance push channel and awaits the reply.

Errors with a remote registry come from the registry layer: typically an offline rejection when the user has no active connection cluster-wide, a timeout when routing succeeded but the client did not reply within `timeoutMs`, or a propagated handler error from the receiving instance. The realtime layer does NOT translate these to `LiveError('NOT_FOUND')`; let your caller distinguish and surface them.

You can wire BOTH (`pushHooks.*` + `remoteRegistry`); the local Map wins when an entry is present and the remote registry is consulted only as fallback. In practice pick one of the two patterns -- the registry-only setup is simpler and the registry already does same-instance short-circuit on its own.

Single-instance setups without a registry continue to throw `LiveError('NOT_FOUND')` for unknown userIds, unchanged.

---

## Prometheus metrics

Opt-in instrumentation for RPC calls, stream subscriptions, and cron executions. Zero overhead if not called.

```js
import { live } from 'svelte-realtime/server';
import { createMetricsRegistry } from 'svelte-adapter-uws-extensions/prometheus';

const registry = createMetricsRegistry();
live.metrics(registry);
```

This registers counters/histograms for:
- `svelte_realtime_rpc_total` -- RPC call count by path and status
- `svelte_realtime_rpc_duration_seconds` -- RPC latency by path
- `svelte_realtime_rpc_errors_total` -- RPC errors by path and code
- `svelte_realtime_stream_subscriptions` -- active stream subscription gauge by topic
- `svelte_realtime_cron_total` -- cron execution count by path and status
- `svelte_realtime_cron_errors_total` -- cron errors by path

---

## Circuit breaker

Wrap a stream or RPC init function with a circuit breaker from `svelte-adapter-uws-extensions`. When the breaker is open, returns a fallback value or throws `SERVICE_UNAVAILABLE`.

```js
import { live } from 'svelte-realtime/server';
import { createBreaker } from 'svelte-adapter-uws-extensions/breaker';

const dbBreaker = createBreaker({ threshold: 5, resetMs: 30000 });

export const items = live.stream('items',
  live.breaker({ breaker: dbBreaker, fallback: [] }, async (ctx) => {
    return db.items.list();
  })
);
```

If `fallback` is omitted and the circuit is open, the call throws `LiveError('SERVICE_UNAVAILABLE', ...)`.

---

## Request correlation

Every live function receives `ctx.requestId` -- a stable identifier for the originating RPC envelope. The id flows in three directions automatically:

- **From clients**: WebSocket clients tag every RPC envelope with a generated id; HTTP request handlers honor `X-Request-ID` headers (and generate one if absent). The adapter writes the resolved id to `platform.requestId`, and the realtime layer copies it to `ctx.requestId` for the duration of that handler.
- **Through your handlers**: pass it to whatever you do downstream so log lines, traces, and persisted rows all share one key.
- **Into background work**: the `svelte-adapter-uws-extensions` postgres tasks/jobs APIs persist `request_id` on every row. Pass it explicitly or pipe `ctx.platform` and the helpers extract it for you.

```js
import { live } from 'svelte-realtime/server';
import { createTasks } from 'svelte-adapter-uws-extensions/postgres/tasks';
import { createJobs } from 'svelte-adapter-uws-extensions/postgres/jobs';

const tasks = createTasks({ client: pgClient });
const jobs = createJobs({ client: pgClient });

export const submitOrder = live(async (ctx, input) => {
  // Option A: explicit -- works anywhere ctx.requestId is in scope
  const order = await tasks.run('processOrder', input, {
    requestId: ctx.requestId
  });

  // Option B: pipe ctx.platform; the helpers read platform.requestId for you
  await jobs.enqueue('shipment-notice', { orderId: order.id }, {
    platform: ctx.platform
  });

  return order;
});
```

Once the rows land, you can join them back to the originating RPC for debugging or audit:

```sql
-- Trace one user request across the websocket -> task -> job pipeline
SELECT
  t.svti_tasks_id, t.name AS task_name, t.status, t.created_at AS task_created,
  j.svti_jobs_id,  j.queue,             j.attempts,
  t.request_id
FROM ws_tasks t
LEFT JOIN ws_jobs j ON j.request_id = t.request_id
WHERE t.request_id = $1
ORDER BY task_created;
```

The id passes opaquely -- no validation, no length cap from the realtime layer. If you generate ids with a structured prefix (`o-` for orders, `a-` for audits), every downstream record carries that prefix too.

If you also instrument with [Prometheus metrics](#prometheus-metrics), include `requestId` in your log fields rather than as a metric label -- it's high-cardinality and would blow up your label space.

---

## Cron scheduling

Use `live.cron()` to run server-side functions on a schedule and publish results to a topic.

```js
import { live } from 'svelte-realtime/server';

export const refreshStats = live.cron('*/5 * * * *', 'stats', async () => {
  return { users: await db.users.count(), orders: await db.orders.todayCount() };
});
```

The cron function publishes its return value as a `set` event on the given topic. Pair it with a `merge: 'set'` stream:

```js
export const stats = live.stream('stats', async (ctx) => {
  return db.stats();
}, { merge: 'set' });
```

The function receives a `ctx` object with `publish`, `throttle`, `debounce`, and `signal` -- the same helpers available in RPC handlers (minus `user` and `ws`, since cron runs outside a connection). Use `ctx.publish` for fine-grained control, e.g. publishing individual `created`/`deleted` events on a crud stream:

```js
export const cleanup = live.cron('0 * * * *', 'boards', async (ctx) => {
  const stale = await listStaleBoards();
  for (const board of stale) {
    await deleteBoard(board.board_id);
    ctx.publish('boards', 'deleted', { board_id: board.board_id });
  }
  // returning undefined skips the automatic 'set' publish
});
```

If the function returns a value, it is published as a `set` event (same as before). If it returns `undefined`, no automatic publish happens -- this lets you use `ctx.publish` exclusively without an unwanted `set` event overwriting your crud updates.

Cron expressions use 5 fields: `minute hour day month weekday`. Supported syntax: `*`, single values, ranges (`9-17`), lists (`0,15,30`), and steps (`*/5`).

The platform is captured automatically from the first RPC call. If your app starts cron jobs before any WebSocket connections, call `setCronPlatform(platform)` in your `open` hook.

---

## Derived streams

Server-side computed streams that recompute when any source topic publishes.

```js
import { live } from 'svelte-realtime/server';

export const dashboardStats = live.derived(
  ['orders', 'inventory', 'users'],
  async () => {
    return {
      totalOrders: await db.orders.count(),
      lowStock: await db.inventory.lowStockCount(),
      activeUsers: await db.users.activeCount()
    };
  },
  { debounce: 500 }
);
```

On the client, derived streams work like regular streams:

```svelte
<script>
  import { dashboardStats } from '$live/dashboard';
</script>

<p>Orders: {$dashboardStats?.totalOrders}</p>
```

### Dynamic derived streams

When source topics depend on runtime arguments (e.g., an org ID, a room ID), pass a source factory function instead of a static array. The factory receives the same args the client passes at subscribe time:

```js
export const orgStats = live.derived(
  (orgId) => [`memberships:${orgId}`, `emails:${orgId}`, `audit:${orgId}`],
  async (ctx, orgId) => {
    const [members, emails, auditCount] = await Promise.all([
      db.query('SELECT count(*) FROM memberships WHERE org_id = $1', [orgId]),
      db.query('SELECT count(*) FROM emails WHERE org_id = $1', [orgId]),
      db.query('SELECT count(*) FROM audit_log WHERE org_id = $1', [orgId])
    ]);
    return { members, emails, auditCount };
  },
  { debounce: 100 }
);
```

On the client, dynamic derived streams are called like functions:

```svelte
<script>
  import { orgStats } from '$live/dashboard';
  let { orgId } = $props();
</script>

<p>Members: {$orgStats(orgId)?.members}</p>
```

Each unique set of args creates an independent instance with its own source subscriptions. Instances are created when the first subscriber connects and cleaned up when the last subscriber disconnects.

### Activation

Call `_activateDerived(platform)` in your `open` hook to enable derived stream listeners:

```js
import { _activateDerived } from 'svelte-realtime/server';

export function open(ws, { platform }) {
  _activateDerived(platform);
}
```

Without this call, derived streams will still serve their initial SSR data but will never receive live updates. In dev mode, a console warning is emitted when a client subscribes to a derived stream and `_activateDerived` has not been called.

Dynamic derived compute functions receive `ctx.user` from the subscribing client, so auth checks like `if (orgId !== ctx.user.organization_id) throw new LiveError("FORBIDDEN")` work the same as they do in regular stream handlers.

| Option | Default | Description |
|---|---|---|
| `merge` | `'set'` | Merge strategy for the derived topic |
| `debounce` | `0` | Debounce recomputation by this many milliseconds |

---

## Effects

Server-side reactive side effects that fire when source topics publish. Fire-and-forget -- no topic, no client subscription.

```js
// src/live/notifications.js
import { live } from 'svelte-realtime/server';

export const orderNotifications = live.effect(['orders'], async (event, data, platform) => {
  if (event === 'created') {
    await email.send(data.userEmail, 'Order confirmed', templates.orderConfirm(data));
  }
});
```

Effects are server-only. They fire whenever a matching topic publishes and cannot be subscribed to from the client.

---

## Aggregates

Real-time incremental aggregations. Reducers run on each event, maintaining O(1) state.

```js
// src/live/stats.js
import { live } from 'svelte-realtime/server';

export const orderStats = live.aggregate('orders', {
  count: { init: () => 0, reduce: (acc, event) => event === 'created' ? acc + 1 : acc },
  total: { init: () => 0, reduce: (acc, event, data) => event === 'created' ? acc + data.amount : acc },
  avg: { compute: (state) => state.count > 0 ? state.total / state.count : 0 }
}, { topic: 'order-stats' });
```

The aggregate publishes its state to the output topic on every event. Clients subscribe to the output topic as a regular stream.

---

## Gates

Conditional stream activation. On the server, a predicate controls whether the client subscribes. On the client, `.when()` manages the subscription lifecycle.

```js
// src/live/beta.js
import { live } from 'svelte-realtime/server';

export const betaFeed = live.gate(
  (ctx) => ctx.user?.flags?.includes('beta'),
  live.stream('beta-feed', async (ctx) => db.betaFeed.latest(50), { merge: 'latest' })
);
```

```svelte
<script>
  import { betaFeed } from '$live/beta';

  import { writable } from 'svelte/store';

  const tabActive = writable(true);
  const feed = betaFeed.when(tabActive);
</script>

{#if $feed !== undefined}
  {#each $feed as item (item.id)}
    <p>{item.title}</p>
  {/each}
{/if}
```

When the predicate returns false, the server responds with a graceful no-op (no error, no subscription). The client store stays `undefined`. `.when()` accepts a boolean, a Svelte store, or a getter function. When given a store, it subscribes/unsubscribes reactively as the value changes. Getter functions are evaluated once at subscribe time; for reactivity with Svelte 5 `$state`, wrap in `$derived` or pass a store.

---

## Pipes

Composable server-side stream transforms. Apply filter, sort, limit, and join operations to both initial data and live events.

```js
// src/live/notifications.js
import { live, pipe } from 'svelte-realtime/server';

export const myNotifications = pipe(
  live.stream('notifications', async (ctx) => {
    return db.notifications.forUser(ctx.user.id);
  }, { merge: 'crud', key: 'id' }),

  pipe.filter((ctx, item) => !item.dismissed),
  pipe.sort('createdAt', 'desc'),
  pipe.limit(20),
  pipe.join('authorId', async (id) => db.users.getName(id), 'authorName')
);
```

| Transform | Initial data | Live events |
|-----------|-------------|-------------|
| `pipe.filter(predicate)` | Filters the array | Initial data only |
| `pipe.sort(field, dir)` | Sorts the array | Initial data only |
| `pipe.limit(n)` | Slices to N items | Initial data only |
| `pipe.join(field, resolver, as)` | Enriches each item | Initial data only |

Piped functions preserve all stream metadata. The client receives already-transformed data.

---

## Binary RPC

Use `live.binary()` to send raw binary data (file uploads, images, protobuf) over WebSocket without base64 encoding.

```js
// src/live/upload.js
import { live } from 'svelte-realtime/server';

export const uploadAvatar = live.binary(async (ctx, buffer, filename) => {
  await storage.put(`avatars/${ctx.user.id}/${filename}`, buffer);
  return { url: `/avatars/${ctx.user.id}/${filename}` };
}, { maxSize: 5 * 1024 * 1024 }); // reject payloads over 5MB (default: 10MB)
```

```svelte
<script>
  import { uploadAvatar } from '$live/upload';

  async function handleFile(e) {
    const file = e.target.files[0];
    const buffer = await file.arrayBuffer();
    const { url } = await uploadAvatar(buffer, file.name);
  }
</script>

<input type="file" accept="image/*" onchange={handleFile} />
```

The wire format uses a compact binary frame: `0x00` marker byte + uint16 BE header length + JSON header + raw binary payload. This avoids base64 overhead entirely.

---

## Rooms

Bundle data, presence, cursors, and scoped actions into a single declaration.

```js
// src/live/collab.js
import { live } from 'svelte-realtime/server';

export const board = live.room({
  topic: (ctx, boardId) => 'board:' + boardId,
  init: async (ctx, boardId) => db.cards.forBoard(boardId),
  presence: (ctx) => ({ name: ctx.user.name, avatar: ctx.user.avatar }),
  cursors: true,
  guard: async (ctx) => {
    if (!ctx.user) throw new LiveError('UNAUTHORIZED');
  },
  actions: {
    addCard: async (ctx, boardId, title) => {
      const card = await db.cards.insert({ boardId, title });
      ctx.publish('created', card);
      return card;
    }
  }
});
```

On the client, the room export becomes an object with sub-streams and actions. Room actions receive the same leading arguments as the topic function (boardId in this case), followed by any action-specific arguments:

```svelte
<script>
  import { board } from '$live/collab';

  const data = board.data(boardId);         // main data stream
  const users = board.presence(boardId);     // presence stream
  const cursors = board.cursors(boardId);    // cursor stream
</script>

{#each $data as card (card.id)}
  <Card {card} />
{/each}

<button onclick={() => board.addCard(boardId, 'New card')}>Add</button>
```

### Room hooks shortcut

Rooms expose a `.hooks` property for one-liner wiring in `hooks.ws.js`:

```js
// src/hooks.ws.js
import { board } from './live/collab.js';

export const { message, close, unsubscribe } = board.hooks;
```

---

## Webhooks

Bridge external HTTP webhooks into your pub/sub topics.

```js
// src/live/integrations.js
import { live } from 'svelte-realtime/server';

export const stripeEvents = live.webhook('payments', {
  verify({ body, headers }) {
    return stripe.webhooks.constructEvent(body, headers['stripe-signature'], webhookSecret);
  },
  transform(event) {
    if (event.type === 'payment_intent.succeeded') {
      return { event: 'created', data: event.data.object };
    }
    return null; // ignore other event types
  }
});
```

Use the handler in a SvelteKit endpoint:

```js
// src/routes/api/stripe/+server.js
import { stripeEvents } from '$live/integrations';

export async function POST({ request, platform }) {
  const body = await request.text();
  const headers = Object.fromEntries(request.headers);
  const result = await stripeEvents.handle({ body, headers, platform });
  return new Response(result.body, { status: result.status });
}
```

---

## Signals

Point-to-point ephemeral messaging. Send a signal to a specific user without broadcasting to a topic.

```js
// Server: send a signal
const handler = live(async (ctx, targetUserId, offer) => {
  ctx.signal(targetUserId, 'call:offer', offer);
});
```

```js
// Client: receive signals
import { onSignal } from 'svelte-realtime/client';

const unsub = onSignal(currentUser.id, (event, data) => {
  if (event === 'call:offer') showIncomingCall(data);
});
```

Enable signal delivery in your `open` hook:

```js
import { enableSignals } from 'svelte-realtime/server';
export function open(ws) { enableSignals(ws); }
```

---

## Schema evolution

Versioned streams with declarative migration functions. When you change a data shape, old clients receive migrated data automatically.

```js
export const todos = live.stream('todos', async (ctx) => {
  return db.todos.all();
}, {
  merge: 'crud',
  key: 'id',
  version: 3,
  migrate: {
    // v1 -> v2: add priority field
    1: (item) => ({ ...item, priority: item.priority ?? 'medium' }),
    // v2 -> v3: rename 'done' to 'completed'
    2: (item) => {
      const { done, ...rest } = item;
      return { ...rest, completed: done ?? false };
    }
  }
});
```

The Vite plugin includes the stream version in the client stub. On reconnect, the client sends its version. If the server is ahead, migration functions chain in order (v1 -> v2 -> v3). If versions match, no migration runs.

---

## Delta sync and replay

### Delta sync

Enable delta sync for efficient reconnection on streams with large datasets. Instead of refetching all data, the server sends only what changed since the client's last known version.

```js
export const inventory = live.stream('inventory', async (ctx) => {
  return db.inventory.all();
}, {
  merge: 'crud',
  key: 'sku',
  delta: {
    version: () => db.inventory.lastModified(),
    diff: async (sinceVersion) => {
      const changes = await db.inventory.changedSince(sinceVersion);
      return changes; // null to force full refetch
    }
  }
});
```

How it works:
- On first connect, the client gets the full dataset plus a `version` value
- On reconnect, the client sends its last known `version`
- If versions match: server responds with `{ unchanged: true }` (nearly zero bytes)
- If versions differ: server calls `diff(sinceVersion)` and sends only the changes
- If diff returns `null`: falls back to full refetch

### Three-tier reconnect with `delta.fromSeq`

For seq-based reconnects where the bounded replay buffer cannot satisfy the gap (the client's `lastSeenSeq` is older than the oldest entry in the buffer), `delta.fromSeq(sinceSeq)` is the user-supplied bridge to the durable store. The server falls back to full rehydrate only when `fromSeq` returns `null` / `undefined`.

```js
export const auditFeed = live.stream(
  (ctx, orgId) => `audit:${orgId}`,
  async (ctx, orgId) => loadAudit(orgId, { limit: 200 }),
  {
    merge: 'crud',
    key: 'id',
    replay: true,
    delta: {
      fromSeq: async (sinceSeq) => {
        const events = await db.auditEvents.where('seq', '>', sinceSeq).orderBy('seq').limit(500);
        if (events.length === 0) return [];        // nothing missed, no-op
        if (events.length === 500) return null;     // too many -> fall through to full rehydrate
        return events;
      }
    }
  }
);
```

Resolution order on reconnect-with-seq: replay buffer (bounded, fast) -> `delta.fromSeq(clientSeq)` (this hook) -> full rehydrate via the loader (always safe). Returning `[]` signals "nothing missed" (client no-op). Each event should carry a `seq` field so the client's `_lastSeq` advances; if the events come from a Postgres column with a `seq` per row, the client tracks correctly without extra plumbing.

### Replay

Enable seq-based replay for gap-free stream reconnection. When a client reconnects, it sends its last known sequence number. If the server has the missed events buffered, it sends only those instead of a full refetch.

```js
export const feed = live.stream('feed', async (ctx) => {
  return db.feed.latest(50);
}, { merge: 'latest', max: 50, replay: true });
```

Replay requires the replay extension from `svelte-adapter-uws-extensions`. When replay is not available or the gap is too large, the client falls back to a full refetch automatically.

With adapter 0.4.0+, the replay end marker sends `{ reqId }` (replay complete) or `{ reqId, truncated: true }` (cache miss). When truncated, the client automatically resets its sequence number and triggers a full refetch.

---

## Redis multi-instance

Use `createMessage` with the Redis pub/sub bus for multi-instance deployments. `ctx.publish` automatically goes through Redis when the platform is wrapped.

```js
// src/hooks.ws.js
import { createMessage } from 'svelte-realtime/server';
import { createRedis, createPubSubBus } from 'svelte-adapter-uws-extensions/redis';

const redis = createRedis();
const bus = createPubSubBus(redis);

export function open(ws, { platform }) {
  bus.activate(platform);
}

export function upgrade({ cookies }) {
  return validateSession(cookies.session_id) || false;
}

export const message = createMessage({ platform: (p) => bus.wrap(p) });
```

No changes needed in your live modules. `ctx.publish` delegates to whatever platform was passed in, so Redis wrapping is transparent.

If you already run Postgres and don't need Redis, you can use the [LISTEN/NOTIFY bridge](#postgres-notify) instead for cross-instance pub/sub.

### What the extensions handle

When you add the Redis extensions from [svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions), you get:

- **Cross-instance pub/sub** with echo suppression (messages from the same instance are dropped on receive) and microtask-batched Redis pipelines (multiple publishes in one event loop tick become a single Redis roundtrip)
- **Distributed presence** with heartbeat-based zombie cleanup -- dead sockets are detected by probing `getBufferedAmount()`, and stale Redis entries are cleaned server-side by a Lua script after a configurable TTL (default 90s)
- **Replay buffers** with atomic sequence numbering via Lua `INCR` + sorted sets -- per-topic ordering is strict, and gap detection triggers a truncation event before replaying what's available
- **Cross-instance rate limiting** via atomic Lua scripts that use `redis.call('TIME')` to avoid clock skew between app servers
- **Circuit breakers** with a three-state machine (healthy / broken / probing) -- when Redis goes down, the breaker trips after a configurable failure threshold, local delivery continues, and a single probe request tests recovery before resuming full traffic

### Combined: Redis + rate limiting

```js
import { createMessage, LiveError } from 'svelte-realtime/server';
import { createRedis, createPubSubBus, createRateLimit } from 'svelte-adapter-uws-extensions/redis';

const redis = createRedis();
const bus = createPubSubBus(redis);
const limiter = createRateLimit(redis, { points: 30, interval: 10000 });

export function open(ws, { platform }) { bus.activate(platform); }
export function upgrade({ cookies }) { return validateSession(cookies.session_id) || false; }

export const message = createMessage({
  platform: (p) => bus.wrap(p),
  async beforeExecute(ws, rpcPath) {
    const { allowed, resetMs } = await limiter.consume(ws);
    if (!allowed)
      throw new LiveError('RATE_LIMITED', `Retry in ${Math.ceil(resetMs / 1000)}s`);
  }
});
```

---

## Postgres NOTIFY

Combine live.stream with the Postgres NOTIFY bridge for zero-code reactivity. A DB trigger fires `pg_notify()`, the bridge calls `platform.publish()`, and the stream auto-updates.

```js
// src/hooks.ws.js
export { message } from 'svelte-realtime/server';
import { createPgClient, createNotifyBridge } from 'svelte-adapter-uws-extensions/postgres';

const pg = createPgClient({ connectionString: process.env.DATABASE_URL });
const notify = createNotifyBridge(pg, {
  channel: 'table_changes',
  parse: (payload) => JSON.parse(payload)
});

export function open(ws, { platform }) {
  notify.activate(platform);
}
```

```js
// src/live/orders.js -- no ctx.publish needed, the DB trigger handles it
export const createOrder = live(async (ctx, items) => {
  return db.orders.insert({ userId: ctx.user.id, items });
});

export const orders = live.stream('orders', async (ctx) => {
  return db.orders.forUser(ctx.user.id);
}, { merge: 'crud', key: 'id' });
```

---

## Failure modes

### Redis goes down

All Redis extensions accept an optional circuit breaker. The breaker trips after a configurable number of consecutive failures (default 5). Once broken, cross-instance pub/sub, presence writes, replay buffering, and distributed rate limiting are skipped entirely -- no retries, no queuing, no thundering herd. Local delivery continues normally: `ctx.publish()` still reaches subscribers on the same instance and across workers. After a configurable timeout (default 30s), the breaker enters a probing state where a single request is allowed through. If it succeeds, the breaker resets to healthy and all extensions resume.

### Instance crashes mid-session

The distributed presence extension runs a heartbeat cycle (default 30s) that probes each tracked WebSocket with `getBufferedAmount()`. Under mass disconnect, the runtime may drop close events entirely -- the heartbeat catches these and triggers a synchronous leave. On the Redis side, stale presence entries are cleaned by a server-side Lua script that scans the hash and removes fields older than the configurable TTL (default 90s). The `LEAVE_SCRIPT` atomically checks whether the same user is still connected on another instance before broadcasting a leave event, so users don't appear to leave and rejoin when a single instance restarts.

### Client reconnects after a long disconnect

Reconnection uses up to three tiers depending on what's available and how large the gap is. The replay buffer (configurable, default 1000 messages per topic) fills small gaps with strict per-topic ordering via atomic Lua sequence numbering. If the gap is too large for replay, delta sync kicks in -- the client sends its last known version, and the server returns only the changes since that version (or `{unchanged: true}` if nothing changed). If neither replay nor delta sync can cover the gap, the client falls back to a full refetch of the init function. All three paths are automatic and require no client-side code changes.

### Send buffer overflow

Each WebSocket connection has a send buffer limit (default 1MB, configurable via `maxBackpressure` in the adapter). When the buffer is full, messages are silently dropped. In dev mode, `handleRpc` logs a warning when a response fails to deliver. For streams that produce high-frequency output, wrap the source with `live.breaker()` or use `live.throttle()` / `live.debounce()` to control the publish rate.

### Batch and queue limits

A single `batch()` call is capped at 50 RPC calls -- the client rejects before sending, and the server enforces the same cap as a safety net. The adapter's client-side send queue holds up to 1000 messages; when full, the oldest item is dropped. The adapter rate-limits WebSocket upgrades per IP with a sliding window (default 10 per 10s) to prevent connection floods.

---

## Clustering

svelte-realtime works with the adapter's `CLUSTER_WORKERS` mode. The adapter spawns N worker threads (default: number of CPUs). On Linux, workers share the port via `SO_REUSEPORT` and the kernel distributes incoming connections. On macOS and Windows, a primary thread accepts connections and routes them to workers via uWS child app descriptors.

Cross-worker `ctx.publish()` calls are batched via microtask coalescing -- all publishes within one event loop tick are bundled into a single `postMessage` to the primary thread, which fans them out to other workers. This keeps IPC overhead constant regardless of publish volume.

Workers are health-checked every 10 seconds. If a worker fails to respond within 30 seconds, it is terminated and restarted with exponential backoff (starting at 100ms, max 5s, up to 50 restart attempts before the process exits). On graceful shutdown (`SIGTERM` / `SIGINT`), the primary stops accepting connections, sends a shutdown signal to all workers, and waits for them to drain in-flight requests and close WebSocket connections with code 1001 (Going Away) so clients reconnect to another instance.

| Method | Cross-worker? | Safe in `live()`? |
|---|---|---|
| `ctx.publish()` | Yes (relayed) | Yes |
| `ctx.platform.send()` | N/A (single ws) | Yes |
| `ctx.platform.sendTo()` | **No** (local only) | Use with caution |
| `ctx.platform.subscribers()` | **No** (local only) | Use with caution |
| `ctx.platform.connections` | **No** (local only) | Use with caution |

`ctx.publish()` is always safe -- it relays across workers and, with Redis wrapping, across instances. For targeted messaging, prefer `publish()` with a user-specific topic over `sendTo()`.

---

## Production limits

### maxPayloadLength (default: 16KB)

Maximum size of a single WebSocket message. If an RPC request exceeds this, the adapter closes the connection (uWS behavior). Increase `maxPayloadLength` in the adapter's websocket config if your app sends large payloads.

### maxBackpressure (default: 1MB)

Per-connection send buffer. When exceeded, messages are silently dropped. `handleRpc` checks the return value of `platform.send()` and warns in dev mode when a response is not delivered.

### Client send queue (max 1000)

The adapter's `sendQueued()` drops the oldest item when the queue exceeds 1000 messages. This queue buffers messages while the WebSocket is reconnecting.

### Batch size (max 50)

A single `batch()` call is limited to 50 RPC calls. The client rejects before sending if the limit is exceeded, and the server enforces the same limit as a safety net. Split into multiple `batch()` calls if you need more.

### Presence refs (max 10,000)

The server tracks presence join/leave refcounts in memory. When the map reaches 10,000 entries, suspended entries (those with a pending leave timer) are evicted first. If the map is still full after eviction, the join is dropped silently.

### Rate-limit identities (max 5,000)

Per-function rate limiting (`live.rateLimit()`) tracks sliding-window buckets in memory. When the bucket map reaches 5,000 entries, stale buckets are swept first. If still full, new identities are rejected with a `RATE_LIMITED` error. Existing identities are unaffected.

### Throttle/debounce timers (max 5,000)

The server tracks active throttle and debounce entries globally. When at capacity, new entries bypass the timer and publish immediately so data is never silently dropped.

### Topic length (max 256 characters)

The adapter rejects topic names longer than 256 characters or containing control characters (byte value < 32). This applies to subscribe, unsubscribe, and batch-subscribe messages.

### ws.subscribe() vs the subscribe hook

`live.stream()` calls `ws.subscribe(topic)` server-side, bypassing the adapter's `subscribe` hook entirely. This is correct -- stream topics are gated by `guard()`, not the subscribe hook.

---

## Error reporting

### onError hook

Both `handleRpc` and `createMessage` accept an `onError` callback for non-LiveError exceptions. `LiveError` throws are expected errors sent to the client; everything else is an unexpected failure that should be reported.

```js
export const message = createMessage({
  onError(path, error, ctx) {
    sentry.captureException(error, {
      tags: { rpc: path },
      user: { id: ctx.user?.id }
    });
  }
});
```

### Standalone onError

For errors in cron jobs, effects, and derived streams, use the standalone `onError` function:

```js
import { onError } from 'svelte-realtime/server';

onError((path, error) => {
  sentry.captureException(error, { tags: { live: path } });
});
```

> `onCronError` still works but is deprecated -- use `onError` instead.

### Dev-mode publish rate warning

In development, the framework samples `platform.pressure.topPublishers` at a configurable interval and logs a one-shot warning per topic when message rate crosses a threshold. Suggests `coalesceBy` and `volatile: true` mitigations and suppresses automatically when the topic is already configured with either.

```js
import { live } from 'svelte-realtime/server';

// Defaults: enabled, threshold 200 events/sec, intervalMs 5000
live.publishRateWarning({ threshold: 500, intervalMs: 10_000 });

// Disable entirely
live.publishRateWarning(false);
```

Production builds constant-fold the activation branch to dead code -- zero overhead. The sampler runs once per platform on the first ctx-helpers cache miss; per-publish cost is unchanged. Topics already in `_topicCoalesce` or `_topicVolatile` are skipped (the user has already addressed them).

### Dev-mode silent-topic warning

In development, the framework arms a one-shot timer when a stream first subscribes to a topic. If no events arrive within `thresholdMs` (default `30000`), it logs a warning naming the topic and the common causes:

```
[svelte-realtime] Topic 'audit:org-1' has subscribers but no events arrived within 30000ms.
  Common causes:
    - missing pg_notify trigger on the underlying table
    - no ctx.publish() call in the relevant handler
    - intentionally low-traffic topic (extend threshold or suppress)
  Configure: live.silentTopicWarning({ thresholdMs: 60000 })
  Suppress:  live.silentTopicWarning({ suppress: ['audit:org-1'] })
  Disable:   live.silentTopicWarning(false)
  See: https://svti.me/silent-topic
```

```js
import { live } from 'svelte-realtime/server';

// Lower the bar (default 30s)
live.silentTopicWarning({ thresholdMs: 5000 });

// Suppress per-topic for known-quiet streams (admin views, scheduled reports)
live.silentTopicWarning({ suppress: ['admin:audit', 'cron:reports'] });

// Disable globally
live.silentTopicWarning(false);
```

Topics starting with `__` (system topics: `__realtime`, `__signal:*`, `__custom`) are always skipped automatically; you don't need to add them to `suppress`. Each topic warns at most once per process; the warning never fires for a topic that has been live, and re-subscribing after a warn does not re-fire. Hard-gated to development -- production builds constant-fold the activation branch to dead code, so apps not in dev mode pay zero cost regardless of configuration.

The watchdog reuses the same lifecycle hooks as the staleness watchdog (`staleAfterMs`): arms on first sub for the topic, observed on every publish, disarms on last unsub. Apps using both features share the per-topic timer machinery without paying twice.

### Per-stream `onError` for loader observability

For streams whose loader can fail, add `onError(err, ctx, topic)` to the stream options. See [Stream lifecycle hooks](#stream-lifecycle-hooks) for the full pattern. Per-stream observers fire alongside the global `onError` setter, not instead of it.

---

## Custom message handling

When you need to mix RPC with custom WebSocket messages, use `onUnhandled` or drop to `handleRpc` directly.

**With createMessage:**
```js
export const message = createMessage({
  onUnhandled(ws, data, platform) {
    // handle non-RPC messages (binary data, custom protocols, etc.)
  }
});
```

**With handleRpc:**
```js
import { handleRpc } from 'svelte-realtime/server';

export function message(ws, { data, platform }) {
  if (handleRpc(ws, data, platform)) return;
  // your custom message handling
}
```

**Progression:** `export { message }` -> `createMessage({...})` -> manual `handleRpc`. Start simple, add options when needed, drop to full control only if you have to.

---

## Server-Side HMR

Changes to files in `src/live/` are hot-reloaded on the server without restarting `npm run dev`. When you save a file, the plugin:

1. Invalidates the changed module in Vite's server module graph
2. Clears all server-side registrations (RPC handlers, guards, cron jobs, derived streams, effects, aggregates)
3. Re-imports the registry module so every `__register*` call runs with the updated handler functions

This applies to all handler types -- `live()`, `live.stream()`, `live.cron()`, `live.derived()`, `live.effect()`, `live.aggregate()`, `live.room()`, `guard()`, and everything else. Adding or deleting files in `src/live/` also triggers a full re-registration.

**Error recovery:** if the edited file has a syntax error, the previous handlers are restored so the server keeps working. Fix the error and save again.

**Active subscriptions:** existing stream subscribers keep their current data and connection. They will receive new events published by the updated handler, but the init function only runs on new subscriptions. A full page reload picks up the latest init logic.

**Cron jobs:** old intervals are cleared and restarted with the updated schedule and handler.

---

## DevTools

In dev mode, the Vite plugin injects an in-browser overlay that shows active streams, RPC history, and connection status. Toggle with `Ctrl+Shift+L`.

The Streams tab lists every store currently mounted on the page. For each one it shows:

| Field | Meaning |
|---|---|
| topic | The wire topic the store is subscribed to (or `?` while loading). |
| merge | The store's merge strategy (`crud`, `latest`, `set`, `presence`, `cursor`). |
| subs | Active subscriber count; the entry disappears when this hits zero. |
| last | Event name of the most recent pub/sub frame and its relative age (`12s ago`). |
| err | Error code + message if the stream is in the error state; cleared on recovery. |

**Click any stream row to expand a per-stream payload preview** -- the most recent 20 envelopes, time + event name + JSON data. Toggle Pretty / Raw via the header buttons (Raw shows full JSON up to ~500 chars; Pretty truncates at ~200 with overflow indicator). Pause stops capturing new events without affecting the live `last:` timestamp; Clear events drops every stream's ring buffer in one click. Pretty/Raw + Pause states persist across reloads via `localStorage`.

**Privacy.** Captured payloads are walked once at write time with key-based redaction. The default redact list covers `password`, `token`, `apiKey` / `api_key`, `secret`, `authorization`, `cookie`, `sessionid` / `session_id`, `csrf` / `csrftoken`. Override or extend at runtime:

```js
import { __devtools } from 'svelte-realtime/client';
if (__devtools) {
  __devtools.redactKeys.add('paymentMethod');
  __devtools.redactKeys.add('ssn');
}
```

Match is case-insensitive and exact-key (no substring fuzz). Redacted values render as `'[REDACTED]'`. Recursion is capped at depth 5 (deeper structures show `'[depth-cap]'`) and arrays at 50 items so a malformed-large payload doesn't pin a graph in memory.

The RPC tab shows pending calls (with elapsed time) and a 50-entry ring buffer of recent results (ok/err, duration). The Connection tab summarizes the same counters.

The overlay is stripped from production builds. Disable it in dev with:

```js
realtime({ devtools: false })
```

---

## Testing

Use `createTestEnv()` from `svelte-realtime/test` to test your live functions without a real WebSocket server.

```js
import { describe, it, expect, afterEach } from 'vitest';
import { createTestEnv } from 'svelte-realtime/test';
import * as chat from '../src/live/chat.js';

describe('chat module', () => {
  const env = createTestEnv();
  afterEach(() => env.cleanup());

  it('sends and receives messages', async () => {
    env.register('chat', chat);

    const alice = env.connect({ id: 'alice', name: 'Alice' });
    const bob = env.connect({ id: 'bob', name: 'Bob' });

    // Subscribe Bob to the messages stream
    const stream = bob.subscribe('chat/messages');
    await new Promise(r => setTimeout(r, 10));

    // Alice sends a message
    const msg = await alice.call('chat/sendMessage', 'Hello!');
    expect(msg.text).toBe('Hello!');

    // Bob receives the live update
    await new Promise(r => setTimeout(r, 10));
    expect(stream.events).toHaveLength(1);
  });
});
```

**TestEnv API:**

| Method | Description |
|---|---|
| `register(moduleName, exports)` | Register a module's live functions |
| `connect(userData)` | Create a fake connected client |
| `cleanup()` | Clear all state (call in `afterEach`) |
| `platform` | The mock platform object |

**TestClient API:**

| Method | Description |
|---|---|
| `call(path, ...args)` | Call a `live()` function |
| `subscribe(path, ...args)` | Subscribe to a `live.stream()` |
| `binary(path, buffer, ...args)` | Call a `live.binary()` function |
| `disconnect()` / `reconnect()` | Simulate connection state changes |

**TestStream API:**

| Property | Description |
|---|---|
| `value` | Latest value from the stream |
| `error` | Error if the stream failed |
| `topic` | The topic the stream is subscribed to |
| `events` | All pub/sub events received |
| `hasMore` | Whether more pages are available |
| `waitFor(predicate, timeout?)` | Wait for a value matching a predicate |
| `simulatePublish(event, data)` | Publish a server-side event to this stream's topic. Equivalent to `env.platform.publish(stream.topic, event, data)`, but discoverable on the stream return where the test is already focused. Throws if the topic is not yet known (await the initial subscribe first). |

### Chaos harness

`createTestEnv({ chaos: { dropRate, seed } })` enables fault injection on `platform.publish` so tests can verify resilience to message drops without spinning a real cluster.

```js
import { createTestEnv } from 'svelte-realtime/test';

// 50% drop rate, deterministic via seed
const env = createTestEnv({
  chaos: { dropRate: 0.5, seed: 'rep-1234' }
});

env.register('chat', chat);
const client = env.connect({ id: 'u1' });
const stream = client.subscribe('chat/messages');

// Publish 100 events; ~50 of them get dropped.
for (let i = 0; i < 100; i++) {
  env.platform.publish('chat-messages', 'created', { id: i });
}
// Same seed -> same drop sequence across runs, so failures replay.
```

Runtime control via `env.chaos`:

| Method/property | Description |
|---|---|
| `env.chaos.set({ dropRate?, seed? })` | Apply (or replace) chaos config mid-test. |
| `env.chaos.disable()` | Equivalent to `set(null)`. |
| `env.chaos.config` | Current `{ dropRate, seed }` or `null`. |
| `env.chaos.dropped` | Running count of `platform.publish` drops. |
| `env.chaos.resetCounter()` | Zero the counter without changing config. |

Currently models the `drop-outbound` scenario only -- `platform.publish` events to subscribers are dropped at the platform layer. RPC replies (`platform.send`) are exempt because timing them out would just hang test code; the chaos harness is for testing pub/sub resilience, not RPC retry behavior.

### Direct ctx unit tests

`createTestContext({ user })` builds a `ctx`-shaped object suitable for direct unit tests of guards and predicates -- helper methods are no-ops, the user / cursor / requestId can be overridden. Use this when the function under test takes `ctx` and synchronously returns a value; reach for `createTestEnv()` only when you need full publish/subscribe round-trips.

```js
import { createTestContext } from 'svelte-realtime/test';

const adminOnly = (ctx) => ctx.user?.role === 'admin';

expect(adminOnly(createTestContext({ user: { role: 'admin' } }))).toBe(true);
expect(adminOnly(createTestContext({ user: { role: 'viewer' } }))).toBe(false);
expect(adminOnly(createTestContext())).toBe(false);
```

The returned shape mirrors the production `_buildCtx`: `user`, `ws`, `platform`, `publish`, `cursor`, `throttle`, `debounce`, `signal`, `batch`, `shed`, `requestId`. Helpers default to no-op stubs (`publish` returns `true`, `shed` returns `false`, etc.), which is correct for predicates that only read `ctx.user` or `ctx.cursor`.

### Asserting guard rejections

`expectGuardRejects(promise, expectedCode?)` is a small ergonomic wrapper for the common "this call should be denied" pattern. It awaits the promise, asserts it rejected with a `LiveError` of the expected code (default `'FORBIDDEN'`), and returns the error so further assertions can run on it.

```js
import { createTestEnv, expectGuardRejects } from 'svelte-realtime/test';

const env = createTestEnv();
env.register('admin', adminModule);

const user = env.connect({ role: 'viewer' });

// Guards that throw FORBIDDEN are the default case
await expectGuardRejects(user.call('admin/destroyAll'));

// Anonymous calls typically reject with UNAUTHENTICATED
const anon = env.connect(null);
await expectGuardRejects(anon.call('admin/destroyAll'), 'UNAUTHENTICATED');

// The rejected error is returned for further assertions
const err = await expectGuardRejects(user.call('admin/destroyAll'));
expect(err.message).toMatch(/admin role/);
```

---

## Server API reference

Import from `svelte-realtime/server`.

| Export | Description |
|---|---|
| `live(fn)` | Mark a function as RPC-callable |
| `live.stream(topic, initFn, options?)` | Create a reactive stream |
| `live.channel(topic, options?)` | Create an ephemeral pub/sub channel |
| `live.binary(fn, options?)` | Mark a function as a binary RPC handler (`maxSize` limits payload, default 10MB) |
| `live.validated(schema, fn)` | RPC with [Standard Schema](https://standardschema.dev/) input validation (Zod, ArkType, Valibot, etc.) |
| `live.cron(schedule, topic, fn)` | Server-side scheduled function |
| `live.derived(sources, fn, options?)` | Server-side computed stream (static or dynamic sources) |
| `live.effect(sources, fn, options?)` | Server-side reactive side effect |
| `live.aggregate(source, reducers, options)` | Real-time incremental aggregation |
| `live.room(config)` | Collaborative room (data + presence + cursors + actions) |
| `live.webhook(topic, config)` | HTTP webhook-to-stream bridge |
| `live.gate(predicate, fn)` | Conditional stream activation |
| `live.rateLimit(config, fn)` | Per-function sliding window rate limiter |
| `live.rateLimits(config)` | Registry-level rate limits with `default` / `overrides` / `exempt` |
| `live.middleware(fn)` | Global middleware (runs before guards) |
| `live.access.*` | Subscribe-time access control helpers |
| `guard(...fns)` | Per-module auth middleware |
| `LiveError(code, message?)` | Typed error (propagates to client) |
| `handleRpc(ws, data, platform, options?)` | Low-level RPC handler |
| `message` | Ready-made message hook |
| `createMessage(options?)` | Custom message hook factory |
| `pipe(stream, ...transforms)` | Composable stream transforms |
| `close` | Ready-made close hook (fires onUnsubscribe for remaining topics) |
| `unsubscribe` | Ready-made unsubscribe hook (fires onUnsubscribe in real time) |
| `setCronPlatform(platform)` | Capture platform for cron jobs |
| `onError(handler)` | Global error handler for cron, effects, and derived |
| `onCronError(handler)` | Deprecated alias for `onError` |
| `enableSignals(ws)` | Enable point-to-point signal delivery |
| `_activateDerived(platform)` | Enable derived stream listeners |
| `live.metrics(registry)` | Opt-in Prometheus metrics |
| `live.breaker(options, fn)` | Circuit breaker wrapper |

---

## Client API reference

Import from `svelte-realtime/client`.

| Export | Description |
|---|---|
| `RpcError` | Typed error with `code` field |
| `batch(fn, options?)` | Group RPC calls into one WebSocket frame |
| `configure(config)` | Connection hooks and offline queue setup |
| `combine(...stores, fn)` | Multi-store composition |
| `onSignal(userId, callback)` | Listen for point-to-point signals |
| `onDerived` | Re-exported from adapter: reactive derived topic subscription |

**Stream store methods** (on `$live/` stream imports):

| Method/Property | Description |
|---|---|
| `error` | `Readable<RpcError \| null>` -- current error, or `null` when healthy |
| `status` | `Readable<'loading' \| 'connected' \| 'reconnecting' \| 'error'>` -- connection status |
| `optimistic(event, data)` | Apply instant UI update, returns rollback function |
| `hydrate(initialData)` | Pre-populate with SSR data |
| `loadMore(...extraArgs)` | Load next page (cursor-based) |
| `hasMore` | Whether more pages are available |
| `enableHistory(maxSize?)` | Start tracking for undo/redo |
| `undo()` / `redo()` | Navigate history |
| `canUndo` / `canRedo` | Whether undo/redo is available |
| `when(condition)` | Conditional subscription |

---

## Vite plugin options

Import from `svelte-realtime/vite`.

```js
import realtime from 'svelte-realtime/vite';

export default {
  plugins: [sveltekit(), uws(), realtime({ dir: 'src/live' })]
};
```

| Option | Default | Description |
|---|---|---|
| `dir` | `'src/live'` | Directory containing live modules |
| `typedImports` | `true` | Generate `.d.ts` for typed `$live/` imports |
| `devtools` | `true` | Enable the in-browser DevTools overlay in dev mode |

The plugin resolves `$live/chat` to `src/live/chat.js`, generates client stubs, supports nested directories (`$live/rooms/lobby`), and watches for file changes in dev mode. When `typedImports` is enabled, it generates type declarations that strip the `ctx` parameter and infer return types.

---

## Benchmarks

The benchmark suite measures the full-stack overhead added by svelte-realtime on top of raw WebSocket messaging: JSON serialization, RPC path resolution, registry lookup, context construction, handler execution, and response encoding. These run in-process with mock objects and isolate the framework cost from network latency.

Run with:

```bash
node bench/rpc.js
```

What gets measured:
- **RPC dispatch overhead**: time for `handleRpc` to parse, look up the registry, build ctx, execute, and respond -- compared to calling the function directly
- **Stream merge throughput**: operations per second for each merge strategy (`crud`, `latest`, `set`, `presence`, `cursor`) applying events to arrays of varying sizes
- **Fast-path rejection**: how quickly non-RPC messages are identified and skipped

Merge strategies use an internal `Map<key, index>` for O(1) lookups instead of linear scans. Updates and upserts on keyed strategies (crud, presence, cursor) are constant-time regardless of array size. Deletes and prepends require an index rebuild (linear), which matches the cost of the delete itself.

### Event batching (browser)

In the browser, incoming pub/sub events are queued and flushed once per `requestAnimationFrame` instead of triggering a Svelte store update per event. This is automatic -- no configuration needed.

With high-frequency streams (e.g. 1000 cursors at 20 updates/sec), this reduces reactive store updates from ~20,000/sec to ~60/sec (one per frame). All merge operations still run, but Svelte only diffs and re-renders once per frame.

In Node/SSR (tests, `__directCall`, etc.), events apply synchronously -- no batching overhead.

See [bench/rpc.js](bench/rpc.js) for the full source.

---

You can also run the package's own tests:

```bash
npm test
```

---

## Tauri and Capacitor

svelte-realtime works with Tauri and Capacitor without any static build or architectural changes.

Both runtimes let you point their webview at a live URL instead of local files. Your SvelteKit app runs on the server as normal -- SSR, WebSocket hydration, live stores, RPC -- and the native wrapper adds platform APIs (camera, push notifications, filesystem, etc.) on top.

**Capacitor** -- `capacitor.config.ts`:

```ts
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.app',
  appName: 'My App',
  server: {
    url: 'https://yourapp.com'
  }
};

export default config;
```

**Tauri** -- `tauri.conf.json`:

```json
{
  "build": {
    "devPath": "https://yourapp.com",
    "distDir": "https://yourapp.com"
  }
}
```

The webview loads your server directly. No static adapter, no URL configuration in the client, nothing special in your SvelteKit code.

---

## License

MIT
