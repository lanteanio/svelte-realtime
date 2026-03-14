# svelte-realtime

Realtime RPC and reactive subscriptions for SvelteKit, built on [svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws).

Write server functions, import them in components, and call them over WebSocket. Streams give you initial data plus live updates in a single Svelte store. No boilerplate, no manual pub/sub wiring, no protocol design.

## What you get

- **RPC over WebSocket** - call server functions from components like regular async functions
- **Reactive streams** - subscribe to a topic and get a Svelte store with initial data + live updates
- **Per-module guards** - auth middleware that runs before every function in a module
- **Five merge strategies** - `crud`, `latest`, `set`, `presence`, and `cursor`
- **Batched RPC** - group multiple calls into a single WebSocket frame
- **Optimistic updates** - apply changes instantly, roll back on failure
- **Dynamic topics** - per-entity streams (per-room, per-user) with automatic caching
- **Schema validation** - `live.validated(schema, fn)` with Zod and Valibot support
- **SSR hydration** - call live functions from `+page.server.js` load, hydrate stores with zero spinners
- **Cron scheduling** - `live.cron()` for server-side scheduled publishing
- **DevTools** - in-browser overlay for active streams, RPC history, and connection status
- **Replay** - seq-based reconnection for gap-free stream recovery
- **Binary RPC** - `live.binary()` for sending raw ArrayBuffer data (file uploads, images, protobuf)
- **Global middleware** - `live.middleware()` for cross-cutting concerns (logging, metrics, auth)
- **Stream pagination** - cursor-based `loadMore()` and `hasMore` for large datasets
- **Stream lifecycle hooks** - `onSubscribe`/`onUnsubscribe` callbacks on streams
- **Error reporting** - `onError` hook for non-LiveError exceptions, `onCronError` for cron failures
- **Connection hooks** - `configure({ onConnect, onDisconnect })` for client-side connection events
- **Typed error codes** - auto-generated `ErrorCode` union type from `LiveError` throws
- **Throttle/debounce** - `ctx.throttle()` and `ctx.debounce()` for rate-limited publishing
- **Request dedup** - identical RPC calls within the same microtask are coalesced automatically
- **Offline queue** - queue RPCs when disconnected, replay on reconnect with configurable strategies
- **Access control** - `live.access.owner()`, `role()`, `team()`, `any()`, `all()` for per-connection publish filtering
- **Derived streams** - `live.derived()` for server-side computed streams that recompute when sources change
- **Rooms** - `live.room()` bundles data + presence + cursors + scoped actions into one declaration
- **Webhooks** - `live.webhook()` bridges external HTTP webhooks into your pub/sub topics
- **Delta sync** - version-based reconnection that sends only changes instead of full refetch
- **Channels** - `live.channel()` for ephemeral pub/sub topics with no database backing
- **Undo/redo** - `enableHistory()`, `undo()`, `redo()` on stream stores
- **Rate limiting** - `live.rateLimit()` for per-function sliding window rate limits
- **Effects** - `live.effect()` for server-side reactive side effects (email, audit, analytics)
- **Aggregates** - `live.aggregate()` for O(1) real-time incremental aggregations
- **Gates** - `live.gate()` for conditional stream activation with server predicates and client `.when()`
- **Pipes** - `pipe()` for composable server-side stream transforms (filter, sort, limit, join)
- **Schema evolution** - versioned streams with declarative migration functions
- **Signals** - `ctx.signal()` for point-to-point ephemeral messaging (WebRTC signaling, DMs)
- **Combine** - `combine()` for client-side multi-store composition
- **Test utilities** - `createTestEnv()` for testing live functions without a real WebSocket server
- **Extension-friendly** - works with Redis pub/sub, Postgres NOTIFY, rate limiting out of the box
- **Zero adapter changes** - runs on top of svelte-adapter-uws, no forks or patches

---

## Table of contents

**Getting started**
- [Installation](#installation)
- [Quick start](#quick-start)

**API reference**
- [Server API](#server-api)
- [Client API](#client-api)
- [Vite plugin](#vite-plugin)

**Patterns**
- [Per-module auth](#per-module-auth)
- [Streams](#streams)
- [Presence and cursors](#presence-and-cursors)
- [Dynamic topics](#dynamic-topics)
- [Batching](#batching)
- [Optimistic updates](#optimistic-updates)
- [Schema validation](#schema-validation)
- [SSR hydration](#ssr-hydration)
- [Cron scheduling](#cron-scheduling)
- [Binary RPC](#binary-rpc)
- [Global middleware](#global-middleware)
- [Stream pagination](#stream-pagination)
- [Stream lifecycle hooks](#stream-lifecycle-hooks)
- [Error reporting](#error-reporting)
- [Connection hooks](#connection-hooks)
- [Throttle and debounce](#throttle-and-debounce)
- [Request deduplication](#request-deduplication)
- [Offline queue](#offline-queue)
- [Access control](#access-control)
- [Derived streams](#derived-streams)
- [Rooms](#rooms)
- [Webhooks](#webhooks)
- [Delta sync](#delta-sync)
- [Replay](#replay)
- [Redis multi-instance](#redis-multi-instance)
- [Rate limiting](#rate-limiting)
- [Postgres NOTIFY](#postgres-notify)
- [Custom message handling](#custom-message-handling)
- [Channels](#channels)
- [Undo and redo](#undo-and-redo)
- [Effects](#effects)
- [Aggregates](#aggregates)
- [Gates](#gates)
- [Pipes](#pipes)
- [Schema evolution](#schema-evolution)
- [Signals](#signals)
- [Combine](#combine)

**Deployment**
- [Clustering](#clustering)
- [Limits and gotchas](#limits-and-gotchas)

**Help**
- [Testing](#testing)
- [License](#license)

---

**Getting started**

## Installation

```bash
npm install svelte-realtime
```

Requires `svelte-adapter-uws >= 0.2.0`, `svelte >= 4.0.0`, and `@sveltejs/kit >= 2.0.0` as peer dependencies.

---

## Quick start

Three files to go from zero to realtime.

**vite.config.js**
```js
import { sveltekit } from '@sveltejs/kit/vite';
import uws from 'svelte-adapter-uws/vite';
import realtime from 'svelte-realtime/vite';

export default { plugins: [sveltekit(), uws(), realtime()] };
```

**src/hooks.ws.js**
```js
export { message } from 'svelte-realtime/server';

export function upgrade({ cookies }) {
  const user = validateSession(cookies.session_id);
  if (!user) return false;
  return { id: user.id, name: user.name };
}
```

**src/live/chat.js**
```js
import { live, LiveError } from 'svelte-realtime/server';
import { db } from '$lib/server/db';

export const sendMessage = live(async (ctx, text) => {
  if (!ctx.user) throw new LiveError('UNAUTHORIZED', 'Login required');
  if (typeof text !== 'string' || text.length > 500)
    throw new LiveError('VALIDATION', 'Invalid message');

  const msg = await db.messages.insert({ userId: ctx.user.id, text });
  ctx.publish('messages', 'created', msg);
  return msg;
});

export const messages = live.stream('messages', async (ctx) => {
  return db.messages.latest(50);
}, { merge: 'crud', key: 'id', prepend: true });
```

**src/routes/chat/+page.svelte**
```svelte
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

That's it. `sendMessage` is a regular async function on the client. `messages` is a Svelte store that loads initial data over RPC, subscribes to the `messages` topic, and merges live updates automatically.

---

**API reference**

## Server API

Import from `svelte-realtime/server`.

### `live(fn)`

Mark a function as RPC-callable. The first argument is always the context object.

```js
export const greet = live(async (ctx, name) => {
  return `Hello, ${name}!`;
});
```

**Context object:**

| Field | Type | Description |
|---|---|---|
| `ctx.user` | `any` | Whatever `upgrade()` returned (your user data) |
| `ctx.ws` | `WebSocket` | The raw WebSocket connection |
| `ctx.platform` | `Platform` | The adapter platform API |
| `ctx.publish` | `function` | Shorthand for `platform.publish()` |
| `ctx.cursor` | `any` | Cursor from a `loadMore()` call, or `null` on first request |
| `ctx.throttle` | `function` | `(topic, event, data, ms)` -- publish at most once per `ms` milliseconds |
| `ctx.debounce` | `function` | `(topic, event, data, ms)` -- publish after `ms` milliseconds of silence |

### `live.stream(topic, initFn, options?)`

Mark a function as a stream provider. The client gets a Svelte store that loads initial data and merges live pub/sub updates.

The topic can be a static string or a function for dynamic per-entity streams (see [Dynamic topics](#dynamic-topics)).

```js
// Static topic
export const items = live.stream('items', async (ctx) => {
  return db.items.all();
}, { merge: 'crud', key: 'id' });

// Dynamic topic -- creates a separate subscription per roomId
export const roomMessages = live.stream(
  (ctx, roomId) => 'chat:' + roomId,
  async (ctx, roomId) => db.messages.forRoom(roomId),
  { merge: 'crud', key: 'id' }
);
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `merge` | `'crud'` | Merge strategy: `'crud'`, `'latest'`, `'set'`, `'presence'`, or `'cursor'` |
| `key` | `'id'` | Key field for `crud` mode |
| `prepend` | `false` | Prepend new items instead of appending (`crud` mode) |
| `max` | `50` | Max items to keep (`latest` mode) |
| `replay` | `false` | Enable seq-based replay for gap-free reconnection (see [Replay](#replay)) |
| `onSubscribe` | -- | Callback `(ctx, topic)` fired when a client subscribes |
| `onUnsubscribe` | -- | Callback `(ctx, topic)` fired when a client disconnects (static topics only) |
| `filter` | -- | Per-connection publish filter `(ctx, event, data) => boolean` |
| `access` | -- | Declarative access control (alias for filter, use `live.access` helpers) |
| `delta` | -- | Delta sync config `{ version, diff }` for efficient reconnection (see [Delta sync](#delta-sync)) |

**Merge strategies:**

- **`crud`** - handles `created`, `updated`, `deleted` events by key. Pairs with `ctx.publish(topic, 'created', item)`.
- **`latest`** - ring buffer of the last N events. Good for activity feeds and logs.
- **`set`** - replaces the entire store value. Good for counters, status indicators, and aggregated data.
- **`presence`** - handles `join`, `leave`, `set` events keyed by `.key`. See [Presence and cursors](#presence-and-cursors).
- **`cursor`** - handles `update`, `remove`, `set` events keyed by `.key`. See [Presence and cursors](#presence-and-cursors).

### `guard(...fns)`

Create a per-module guard. Runs before every `live()` and `live.stream()` in the same file. Export it as `_guard`. Accepts one or more middleware functions -- they run in order, and earlier ones can enrich `ctx` for later ones.

```js
// Single guard
export const _guard = guard((ctx) => {
  if (ctx.user?.role !== 'admin')
    throw new LiveError('FORBIDDEN', 'Admin only');
});

// Stacked middleware -- runs in order, stops on first throw
export const _guard = guard(
  (ctx) => { if (!ctx.user) throw new LiveError('UNAUTHORIZED'); },
  (ctx) => { ctx.permissions = lookupPermissions(ctx.user.id); },
  (ctx) => { if (!ctx.permissions.includes('write')) throw new LiveError('FORBIDDEN'); }
);
```

### `live.validated(schema, fn)`

Mark a function as RPC-callable with input validation. Validates `args[0]` against the schema before calling `fn`. Supports Zod and Valibot schemas.

```js
import { z } from 'zod';
import { live } from 'svelte-realtime/server';

const SendSchema = z.object({ text: z.string().min(1).max(500) });

export const send = live.validated(SendSchema, async (ctx, input) => {
  // input is validated and typed
  const msg = await db.messages.insert({ userId: ctx.user.id, text: input.text });
  ctx.publish('messages', 'created', msg);
  return msg;
});
```

On validation failure, the client receives an `RpcError` with `code: 'VALIDATION'` and an `issues` array:

```js
try {
  await send({ text: '' });
} catch (err) {
  // err.code === 'VALIDATION'
  // err.issues === [{ path: ['text'], message: 'String must contain at least 1 character(s)' }]
}
```

### `live.cron(schedule, topic, fn)`

Create a server-side scheduled function that publishes results to a topic on a cron schedule. Uses standard 5-field cron expressions (minute hour day month weekday).

```js
export const refreshStats = live.cron('*/5 * * * *', 'stats', async () => {
  return db.stats();
});
```

Supported cron syntax: `*`, single values (`5`), ranges (`9-17`), lists (`0,15,30,45`), steps (`*/5`).

Call `setCronPlatform(platform)` in your `open` hook if you use cron jobs. If you use `handleRpc`, the platform is captured automatically on the first RPC call.

### `live.binary(fn)`

Mark a function as a binary RPC handler. The handler receives `(ctx, buffer, ...jsonArgs)` where `buffer` is the raw `ArrayBuffer` sent by the client. See [Binary RPC](#binary-rpc).

```js
export const uploadAvatar = live.binary(async (ctx, buffer, filename) => {
  await storage.put(`avatars/${ctx.user.id}/${filename}`, buffer);
  return { url: `/avatars/${ctx.user.id}/${filename}` };
});
```

### `live.middleware(fn)`

Register a global middleware that runs before per-module guards for every RPC and stream call. Middleware receives `(ctx, next)` -- call `next()` to continue the chain. Throw `LiveError` to reject. See [Global middleware](#global-middleware).

```js
live.middleware(async (ctx, next) => {
  const start = Date.now();
  const result = await next();
  console.log(`RPC took ${Date.now() - start}ms`);
  return result;
});
```

When no middleware is registered, there is zero overhead -- the handler is called directly.

### `live.derived(sources, fn, options?)`

Create a server-side computed stream that recomputes when any source topic publishes. See [Derived streams](#derived-streams).

```js
export const summary = live.derived(['orders', 'inventory'], async () => {
  return { totalOrders: await db.orders.count(), totalItems: await db.inventory.count() };
}, { merge: 'set', debounce: 100 });
```

| Option | Default | Description |
|---|---|---|
| `merge` | `'set'` | Merge strategy for the derived topic |
| `debounce` | `0` | Debounce recomputation by this many milliseconds |

### `live.room(config)`

Create a collaborative room that bundles data, presence, cursors, and scoped actions. See [Rooms](#rooms).

```js
export const board = live.room({
  topic: (ctx, boardId) => 'board:' + boardId,
  init: async (ctx, boardId) => db.boards.get(boardId),
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  actions: {
    addCard: async (ctx, title) => { ... }
  }
});
```

### `live.webhook(topic, config)`

Create a webhook-to-stream bridge. See [Webhooks](#webhooks).

```js
export const stripeEvents = live.webhook('payments', {
  verify: ({ body, headers }) => stripe.webhooks.constructEvent(body, headers['stripe-signature'], secret),
  transform: (event) => ({ event: event.type, data: event.data.object })
});
```

### `live.access`

Declarative access control helpers for stream filtering. See [Access control](#access-control).

| Helper | Description |
|---|---|
| `live.access.owner(field)` | Only allow events where `data[field] === ctx.user.id` |
| `live.access.role(map)` | Role-based: `{ admin: true, viewer: (ctx, data) => ... }` |
| `live.access.team(field)` | Only allow events where `data[field] === ctx.user.teamId` |
| `live.access.any(...predicates)` | OR logic: any predicate returning true allows the event |
| `live.access.all(...predicates)` | AND logic: all predicates must return true |

### `onCronError(handler)`

Set a global error handler for cron job failures. Without this, cron errors are logged in dev and silently swallowed in production.

```js
import { onCronError } from 'svelte-realtime/server';

onCronError((path, error) => {
  sentry.captureException(error, { tags: { cron: path } });
});
```

### `close`

Ready-made close hook. Re-export from your `hooks.ws.js` to fire `onUnsubscribe` lifecycle hooks when clients disconnect.

```js
export { close } from 'svelte-realtime/server';
```

### `setCronPlatform(platform)`

Capture a platform reference for cron jobs. Call this in your `open` hook.

```js
import { setCronPlatform } from 'svelte-realtime/server';

export function open(ws, { platform }) {
  setCronPlatform(platform);
}
```

### `LiveError(code, message?)`

Typed error that sends `code` and `message` to the client. Raw `Error` throws are caught and replaced with a generic `INTERNAL_ERROR` to prevent information leaks.

```js
throw new LiveError('VALIDATION', 'Name is required');
```

### `handleRpc(ws, data, platform, options?)`

Low-level: check if a WebSocket message is an RPC request and handle it. Returns `true` if handled, `false` to pass through.

```js
export function message(ws, { data, platform }) {
  if (handleRpc(ws, data, platform)) return;
  // custom non-RPC handling here
}
```

**Options:**

| Option | Description |
|---|---|
| `beforeExecute(ws, rpcPath, args)` | Async hook that runs after the guard but before the function. Throw `LiveError` to reject. |
| `onError(path, error, ctx)` | Called when a handler throws a non-LiveError. Use for error reporting. |

### `message`

Ready-made message hook. Re-export from your `hooks.ws.js` for zero-config RPC routing.

```js
export { message } from 'svelte-realtime/server';
```

### `createMessage(options?)`

Create a custom message hook with options baked in.

```js
export const message = createMessage({
  platform: (p) => bus.wrap(p),
  async beforeExecute(ws, rpcPath) {
    const { allowed, resetMs } = await limiter.consume(ws);
    if (!allowed) throw new LiveError('RATE_LIMITED', `Retry in ${Math.ceil(resetMs / 1000)}s`);
  },
  onUnhandled(ws, data, platform) {
    // handle non-RPC messages
  }
});
```

**Options:**

| Option | Description |
|---|---|
| `platform(p)` | Transform the platform (e.g., wrap with Redis pub/sub bus) |
| `beforeExecute(ws, rpcPath, args)` | Rate limiting, logging, metrics |
| `onError(path, error, ctx)` | Called when a handler throws a non-LiveError |
| `onUnhandled(ws, data, platform)` | Called for non-RPC messages |

**Progression:** `export { message }` -> `createMessage({...})` -> manual `handleRpc`. Start simple, add options when needed, drop to full control only if you have to.

---

## Client API

Import from `svelte-realtime/client`.

### `RpcError`

Typed error with a `code` field. Thrown when an RPC call fails.

```js
import { sendMessage } from '$live/chat';

try {
  await sendMessage(text);
} catch (err) {
  if (err.code === 'VALIDATION') {
    // handle validation error
  }
}
```

### `batch(fn, options?)`

Group multiple RPC calls into a single WebSocket frame. All calls are sent together and responses come back in one frame.

```js
import { batch } from 'svelte-realtime/client';
import { addTodo, assignUser } from '$live/boards';

const [todo, user] = await batch(() => [
  addTodo('Buy milk'),
  assignUser(todoId, userId)
]);
```

Pass `{ sequential: true }` to run calls in order on the server (default is parallel):

```js
const [account, transfer] = await batch(() => [
  createAccount(name),
  transferFunds(fromId, toId, amount)
], { sequential: true });
```

Batches are limited to 50 calls per frame. Each call resolves or rejects independently -- one failure does not cancel the others.

### `configure(config)`

Set up client-side connection lifecycle hooks. Call once at app startup (e.g., in your root `+layout.svelte`).

```js
import { configure } from 'svelte-realtime/client';

configure({
  onConnect() { showToast('Back online'); },
  onDisconnect() { showToast('Connection lost'); }
});
```

| Option | Description |
|---|---|
| `onConnect()` | Called when the WebSocket connection opens after a reconnect |
| `onDisconnect()` | Called when the WebSocket connection closes |
| `beforeReconnect()` | Called before each reconnection attempt (can be async) |

### `$live/` imports

The Vite plugin generates client stubs automatically:

- `live()` exports become async functions that send RPC calls over WebSocket
- `live.stream()` exports become Svelte stores with initial data + live updates
- Dynamic `live.stream()` exports become factory functions that return cached stores per argument set

```svelte
<script>
  import { sendMessage, messages } from '$live/chat';
  // sendMessage = async function
  // messages = Svelte store
</script>
```

**Store states:**

| Value | Meaning |
|---|---|
| `undefined` | Loading (initial fetch in progress) |
| `Array` / `any` | Data loaded and receiving live updates |
| `{ error: RpcError }` | Initial fetch failed |

**Store methods:**

- `store.optimistic(event, data)` -- apply an instant UI update, returns a rollback function. See [Optimistic updates](#optimistic-updates).
- `store.hydrate(initialData)` -- pre-populate with SSR data to avoid loading spinners. See [SSR hydration](#ssr-hydration).
- `store.loadMore(...extraArgs)` -- load the next page of data (cursor-based). Returns a `Promise<boolean>` indicating whether more pages remain. See [Stream pagination](#stream-pagination).
- `store.hasMore` -- read-only boolean indicating whether more pages are available.

---

## Vite plugin

Import from `svelte-realtime/vite`.

```js
import realtime from 'svelte-realtime/vite';

export default {
  plugins: [sveltekit(), uws(), realtime({ dir: 'src/live' })]
};
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `dir` | `'src/live'` | Directory containing live modules |
| `typedImports` | `true` | Generate `$types.d.ts` in the live directory for typed `$live/` imports |
| `devtools` | `true` | Enable the in-browser DevTools overlay in dev mode (stripped from production) |

When `typedImports` is enabled, the plugin generates a `$types.d.ts` file in your live directory. For TypeScript source files, it extracts real parameter and return types (stripping the `ctx` first parameter). For JavaScript files, it falls back to `any`. The file is regenerated on every build and HMR update.

The plugin:
- Resolves `$live/chat` to `src/live/chat.js`
- On SSR: re-exports the real server module
- On client: generates lightweight stubs
- Generates a registry module that registers all live functions at startup
- Supports nested directories: `$live/rooms/lobby` -> `src/live/rooms/lobby.js`
- Watches for file changes and invalidates virtual modules in dev mode

---

**Patterns**

## Per-module auth

Every file in `src/live/` can export a `_guard` that runs before all functions in that file.

**src/live/admin.js**
```js
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

---

## Streams

### crud (default)

Handles `created`, `updated`, `deleted` events. The store maintains an array, keyed by `id` (configurable).

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

Ring buffer of the last N events. Good for activity feeds.

```js
export const activity = live.stream('activity', async (ctx) => {
  return db.activity.recent(100);
}, { merge: 'latest', max: 100 });
```

### set

Replaces the entire value. Good for counters and aggregated data.

```js
export const stats = live.stream('stats', async (ctx) => {
  return { users: 42, messages: 1337 };
}, { merge: 'set' });
```

### Reconnection

When the WebSocket reconnects, streams automatically refetch initial data and resubscribe. The store keeps showing stale data during the refetch to avoid UI flashes -- it does not reset to `undefined`.

### Error handling

If the initial fetch fails, the store value becomes `{ error: RpcError }`:

```svelte
{#if $messages === undefined}
  <p>Loading...</p>
{:else if $messages?.error}
  <p>Failed: {$messages.error.message}</p>
{:else}
  {#each $messages as msg (msg.id)}
    <p>{msg.text}</p>
  {/each}
{/if}
```

---

## Presence and cursors

Two built-in merge strategies for tracking who is online and where their cursor is.

### presence

Tracks connected users with `join` and `leave` events. Items are keyed by `.key`.

**src/live/room.js**
```js
import { live } from 'svelte-realtime/server';

export const presence = live.stream(
  (ctx, roomId) => 'presence:' + roomId,
  async (ctx, roomId) => [], // start empty, users join via events
  { merge: 'presence' }
);

export const join = live(async (ctx, roomId) => {
  ctx.publish('presence:' + roomId, 'join', { key: ctx.user.id, name: ctx.user.name });
});

export const leave = live(async (ctx, roomId) => {
  ctx.publish('presence:' + roomId, 'leave', { key: ctx.user.id });
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

Events: `join` (add or update by key), `leave` (remove by key), `set` (replace all).

### cursor

Tracks cursor positions with `update` and `remove` events. Items are keyed by `.key`.

**src/live/cursors.js**
```js
import { live } from 'svelte-realtime/server';

export const cursors = live.stream(
  (ctx, docId) => 'cursors:' + docId,
  async (ctx, docId) => [],
  { merge: 'cursor' }
);

export const moveCursor = live(async (ctx, docId, x, y) => {
  ctx.publish('cursors:' + docId, 'update', { key: ctx.user.id, x, y, color: ctx.user.color });
});
```

Events: `update` (add or update by key), `remove` (remove by key), `set` (replace all).

---

## Dynamic topics

Use a function instead of a string as the first argument to `live.stream()` for per-entity streams. The client-side stub becomes a factory function -- call it with arguments to get a cached store for that entity.

**src/live/rooms.js**
```js
import { live } from 'svelte-realtime/server';
import { db } from '$lib/server/db';

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

**src/routes/rooms/[id]/+page.svelte**
```svelte
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

By default, calls in a batch run in parallel on the server. Pass `{ sequential: true }` when order matters (e.g., create-then-reference):

```js
const [board, column] = await batch(() => [
  createBoard('My Board'),
  addColumn(boardId, 'To Do')
], { sequential: true });
```

Each call resolves or rejects independently -- one failure does not cancel the others.

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

`optimistic(event, data)` returns a rollback function that restores the store to its previous state. It works with all three merge strategies:

| Merge | Events | Behavior |
|---|---|---|
| `crud` | `created`, `updated`, `deleted` | Modifies array by key. Server event with same key replaces the optimistic entry. |
| `latest` | any event name | Appends data to the ring buffer. |
| `set` | any event name | Replaces the entire value. |

---

## Schema validation

Use `live.validated(schema, fn)` to validate the first argument against a Zod or Valibot schema before the function runs.

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

On the client side, `live.validated()` exports work like regular `live()` calls. Validation errors are thrown as `RpcError` with `code: 'VALIDATION'` and an `issues` array containing structured error details.

Valibot schemas are also supported -- the validation adapter detects the schema type automatically.

---

## SSR hydration

Call live functions from `+page.server.js` to load data server-side, then hydrate the client-side stream store to avoid loading spinners.

**src/routes/chat/+page.server.js**
```js
export async function load({ platform }) {
  const { messages } = await import('$live/chat');
  const data = await messages.load(platform);
  return { messages: data };
}
```

**src/routes/chat/+page.svelte**
```svelte
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

The hydrated store still subscribes for live updates on first render. It keeps the SSR data visible instead of showing `undefined` during the initial fetch.

In SSR mode, the Vite plugin adds `.load(platform, options?)` methods to stream exports. These call `__directCall()` internally, which runs the stream init function in-process without a WebSocket connection. Guards still run. Pass `{ user }` as the second argument if your guard or init function needs user data.

---

## Cron scheduling

Use `live.cron()` to run server-side functions on a schedule and publish results to a topic.

```js
import { live } from 'svelte-realtime/server';

export const refreshStats = live.cron('*/5 * * * *', 'stats', async () => {
  return { users: await db.users.count(), orders: await db.orders.todayCount() };
});
```

The cron function publishes its return value as a `set` event on the given topic. Any stream subscribed to that topic with `merge: 'set'` will update automatically.

```js
export const stats = live.stream('stats', async (ctx) => {
  return db.stats();
}, { merge: 'set' });
```

Cron expressions use 5 fields: `minute hour day month weekday`. Supported syntax: `*`, single values, ranges (`9-17`), lists (`0,15,30`), and steps (`*/5`).

The platform is captured automatically from the first RPC call. If your app starts cron jobs before any WebSocket connections, call `setCronPlatform(platform)` in your `open` hook.

---

## Binary RPC

Use `live.binary()` on the server and the generated `$live/` stubs to send raw binary data (file uploads, images, protobuf) over WebSocket without base64 encoding.

**src/live/upload.js**
```js
import { live } from 'svelte-realtime/server';

export const uploadAvatar = live.binary(async (ctx, buffer, filename) => {
  if (buffer.byteLength > 5 * 1024 * 1024)
    throw new LiveError('VALIDATION', 'File too large (5MB max)');

  await storage.put(`avatars/${ctx.user.id}/${filename}`, buffer);
  return { url: `/avatars/${ctx.user.id}/${filename}` };
});
```

**src/routes/profile/+page.svelte**
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

## Stream pagination

For large datasets, return `{ data, hasMore, cursor }` from your stream init function to enable cursor-based pagination.

**src/live/feed.js**
```js
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

**src/routes/feed/+page.svelte**
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

`onSubscribe` fires after `ws.subscribe(topic)` and the initial data fetch. `onUnsubscribe` fires when the WebSocket closes (requires exporting `close` from your `hooks.ws.js`):

```js
export { message, close } from 'svelte-realtime/server';
```

`onUnsubscribe` only fires automatically for static topics. For dynamic topics, the adapter's `ws.getTopics()` is the source of truth for which topics a connection was on.

---

## Error reporting

### `onError` hook

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

### `onCronError` hook

For cron jobs, use the standalone `onCronError` function:

```js
import { onCronError } from 'svelte-realtime/server';

onCronError((path, error) => {
  sentry.captureException(error, { tags: { cron: path } });
});
```

---

## Connection hooks

Use `configure()` on the client to react to WebSocket connection state changes.

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { configure } from 'svelte-realtime/client';

  configure({
    onConnect() {
      // Reconnected after a drop -- refresh stale non-stream data
      invalidateAll();
    },
    onDisconnect() {
      showBanner('Connection lost, reconnecting...');
    }
  });
</script>
```

Call `configure()` once at app startup. The hooks fire on state transitions only (not on the initial connection).

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

## Request deduplication

Identical RPC calls made within the same microtask are automatically coalesced into a single request. This prevents duplicate network requests from concurrent renders or event handlers.

```js
// These two calls happen in the same microtask -- only one request is sent
const [a, b] = await Promise.all([
  getUser(userId),
  getUser(userId) // same call, same args -- reuses the first request
]);
```

To bypass deduplication and force a fresh request:

```js
import { getUser } from '$live/users';

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

When offline queuing is enabled, RPC calls made while disconnected return promises that resolve when the call is replayed after reconnection. If the queue overflows, the oldest entry is dropped and its promise rejects with `QUEUE_FULL`.

---

## Access control

Use `live.access` helpers to filter pub/sub events per connection. Only matching events are delivered to each subscriber.

```js
import { live } from 'svelte-realtime/server';

// Only deliver events where the userId matches the connected user
export const myOrders = live.stream('orders', async (ctx) => {
  return db.orders.forUser(ctx.user.id);
}, {
  merge: 'crud',
  access: live.access.owner('userId')
});

// Role-based: admins see everything, viewers only see public items
export const items = live.stream('items', async (ctx) => {
  return db.items.all();
}, {
  merge: 'crud',
  access: live.access.role({
    admin: true,
    viewer: (ctx, data) => data.public === true
  })
});

// Combine with any() or all()
export const teamDocs = live.stream('docs', async (ctx) => {
  return db.docs.all();
}, {
  merge: 'crud',
  access: live.access.any(
    live.access.owner('createdBy'),
    live.access.team('teamId')
  )
});
```

---

## Derived streams

Use `live.derived()` to create server-side computed streams that recompute when any source topic publishes.

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
  { debounce: 500 } // avoid recomputing on every rapid-fire event
);
```

On the client, derived streams work like regular streams:

```svelte
<script>
  import { dashboardStats } from '$live/dashboard';
</script>

<p>Orders: {$dashboardStats?.totalOrders}</p>
```

Call `_activateDerived(platform)` in your `open` hook to enable derived stream listeners:

```js
import { _activateDerived } from 'svelte-realtime/server';

export function open(ws, { platform }) {
  _activateDerived(platform);
}
```

---

## Rooms

Use `live.room()` to bundle data, presence, cursors, and scoped actions into a single declaration.

**src/live/collab.js**
```js
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
    addCard: async (ctx, title) => {
      const card = await db.cards.insert({ boardId: ctx.args[0], title });
      ctx.publish('created', card); // scoped to the room's topic
      return card;
    }
  }
});
```

On the client, the room export becomes an object with sub-streams and actions:

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

<button onclick={() => board.addCard('New card')}>Add</button>
```

---

## Webhooks

Use `live.webhook()` to bridge external HTTP webhooks into your pub/sub topics.

**src/live/integrations.js**
```js
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

**src/routes/api/stripe/+server.js**
```js
import { stripeEvents } from '$live/integrations';

export async function POST({ request, platform }) {
  const body = await request.text();
  const headers = Object.fromEntries(request.headers);
  const result = await stripeEvents.handle({ body, headers, platform });
  return new Response(result.body, { status: result.status });
}
```

---

## Delta sync

Enable delta sync for efficient reconnection on streams with large datasets. Instead of refetching all data, the server sends only what changed since the client's last known version.

```js
export const inventory = live.stream('inventory', async (ctx) => {
  return db.inventory.all();
}, {
  merge: 'crud',
  key: 'sku',
  delta: {
    version: () => db.inventory.lastModified(),    // fast version check
    diff: async (sinceVersion) => {                // return only changes
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
- Compatible with replay (replay handles the micro-gap, delta handles the macro-gap)

---

## Replay

Enable seq-based replay for gap-free stream reconnection. When a client reconnects, it sends its last known sequence number. If the server has the missed events buffered, it sends only those instead of a full refetch.

```js
export const feed = live.stream('feed', async (ctx) => {
  return db.feed.latest(50);
}, { merge: 'latest', max: 50, replay: true });
```

Replay requires the replay extension from `svelte-adapter-uws-extensions`. The extension buffers recent events per topic and provides `platform.replay.since(topic, seq)` and `platform.replay.seq(topic)` methods.

When replay is not available or the gap is too large, the client falls back to a full refetch automatically. The client tracks sequence numbers from both the initial response and subsequent pub/sub events.

---

## DevTools

In dev mode, the Vite plugin injects an in-browser overlay that shows active streams, RPC history, and connection status. Toggle with `Ctrl+Shift+L`.

The overlay is stripped from production builds. Disable it in dev with:

```js
realtime({ devtools: false })
```

---

## Redis multi-instance

Use `createMessage` with the Redis pub/sub bus for multi-instance deployments. `ctx.publish` automatically goes through Redis when the platform is wrapped.

**src/hooks.ws.js**
```js
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

---

## Rate limiting

Use the `beforeExecute` hook with the rate limit extension.

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

**src/hooks.ws.js**
```js
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

**src/live/orders.js**
```js
import { live } from 'svelte-realtime/server';
import { db } from '$lib/server/db';

// No ctx.publish needed - the DB trigger handles it
export const createOrder = live(async (ctx, items) => {
  return db.orders.insert({ userId: ctx.user.id, items });
});

export const orders = live.stream('orders', async (ctx) => {
  return db.orders.forUser(ctx.user.id);
}, { merge: 'crud', key: 'id' });
```

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

---

**Deployment**

## Clustering

svelte-realtime works with the adapter's `CLUSTER_WORKERS` mode. Key points:

| Method | Cross-worker? | Safe in `live()`? |
|---|---|---|
| `ctx.publish()` | Yes (relayed) | Yes |
| `ctx.platform.send()` | N/A (single ws) | Yes |
| `ctx.platform.sendTo()` | **No** (local only) | Use with caution |
| `ctx.platform.subscribers()` | **No** (local only) | Use with caution |
| `ctx.platform.connections` | **No** (local only) | Use with caution |

`ctx.publish()` is always safe -- it relays across workers and, with Redis wrapping, across instances. For targeted messaging, prefer `publish()` with a user-specific topic over `sendTo()`.

---

## Limits and gotchas

### maxPayloadLength (default: 16KB)

If an RPC request exceeds this, the adapter closes the connection silently (uWS behavior). If your app sends large payloads, increase `maxPayloadLength` in the adapter's websocket config.

### maxBackpressure (default: 1MB)

If a connection's send buffer exceeds this, messages are silently dropped. `handleRpc` checks the return value of `platform.send()` and warns in dev mode if a response was not delivered.

### sendQueue cap (client-side, max 1000)

The adapter's `sendQueued()` drops the oldest item if the queue exceeds 1000. Unlikely in practice, but worth knowing for offline-heavy apps.

### Batch size (max 50 calls)

A single `batch()` call is limited to 50 RPC calls. If exceeded, the server rejects the entire batch. If you need more, split into multiple `batch()` calls.

### ws.subscribe() vs the subscribe hook

`live.stream()` calls `ws.subscribe(topic)` server-side, bypassing the adapter's `subscribe` hook entirely. This is correct -- stream topics are gated by `guard()`, not the subscribe hook.

---

**Help**

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

  let tabActive = $state(true);
  const feed = betaFeed.when(tabActive);
</script>

{#if $feed !== undefined}
  {#each $feed as item (item.id)}
    <p>{item.title}</p>
  {/each}
{/if}
```

When the predicate returns false, the server responds with a graceful no-op (no error, no subscription). The client store stays `undefined`. The client `.when()` subscribes when the condition is truthy and unsubscribes when falsy.

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
| `pipe.filter(predicate)` | Filters the array | Drops non-matching events |
| `pipe.sort(field, dir)` | Sorts the array | Initial data only |
| `pipe.limit(n)` | Slices to N items | Initial data only |
| `pipe.join(field, resolver, as)` | Enriches each item | Initial data only |

Piped functions preserve all stream metadata. The client receives already-transformed data.

---

## Schema evolution

Versioned streams with declarative migration functions. When you change a data shape, old clients receive migrated data automatically.

```js
// src/live/todos.js
import { live } from 'svelte-realtime/server';

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

const unsub = onSignal((event, data) => {
  if (event === 'call:offer') showIncomingCall(data);
});
```

Enable signal delivery in your `open` hook:

```js
import { enableSignals } from 'svelte-realtime/server';
export function open(ws) { enableSignals(ws); }
```

---

## Combine

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

You can also run the package's own tests:

```bash
npm test
```

---

## License

MIT
