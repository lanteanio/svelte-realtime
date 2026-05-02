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
- [Error handling](#error-handling)
- [Per-module auth](#per-module-auth)
- [Dynamic topics](#dynamic-topics)
- [Schema validation](#schema-validation)
- [Channels](#channels)
- [SSR hydration](#ssr-hydration)

**Client features**
- [Batching](#batching)
- [Optimistic updates](#optimistic-updates)
- [Stream pagination](#stream-pagination)
- [Undo and redo](#undo-and-redo)
- [Request deduplication](#request-deduplication)
- [Offline queue](#offline-queue)
- [Connection hooks](#connection-hooks)
- [Combine stores](#combine-stores)

**Server features**
- [Global middleware](#global-middleware)
- [Throttle and debounce](#throttle-and-debounce)
- [Stream lifecycle hooks](#stream-lifecycle-hooks)
- [Access control](#access-control)
- [Rate limiting](#rate-limiting)
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
| `onSubscribe` | -- | Callback `(ctx, topic)` fired when a client subscribes |
| `onUnsubscribe` | -- | Callback `(ctx, topic)` fired when a client disconnects |
| `filter` / `access` | -- | Per-connection publish filter (see [Access control](#access-control)) |
| `delta` | -- | Delta sync config (see [Delta sync and replay](#delta-sync-and-replay)) |
| `version` | -- | Schema version (see [Schema evolution](#schema-evolution)) |
| `migrate` | -- | Migration functions (see [Schema evolution](#schema-evolution)) |

### Reconnection

When the WebSocket reconnects, streams automatically refetch initial data and resubscribe. The store keeps showing stale data during the refetch -- it does not reset to `undefined`.

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
  onUnsubscribe(ctx, topic) {
    ctx.publish(topic, 'leave', { key: ctx.user.id });
  }
});
```

`onSubscribe` fires after `ws.subscribe(topic)` and the initial data fetch. `onUnsubscribe` fires in real time when a client unsubscribes from a topic (adapter 0.4.0+), and also when the WebSocket closes for any remaining topics. Export both hooks from your `hooks.ws.js`:

```js
export { message, close, unsubscribe } from 'svelte-realtime/server';
```

`onUnsubscribe` fires for both static and dynamic topics. For dynamic topics, the server tracks which stream produced each subscription and fires the correct hook. The `unsubscribe` hook fires as soon as the client drops a topic; `close` only fires for topics still active at disconnect time. There is no double-firing.

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
| `live.access.any(...predicates)` | OR: any predicate returning true allows the subscription |
| `live.access.all(...predicates)` | AND: all predicates must return true |

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
