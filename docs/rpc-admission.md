# RPC admission

Every wire call a worker accepts holds memory until its handler settles: the parsed arguments, the `ctx`, the pending promise and the client's own entry waiting for the reply. When a dependency slows down, the number of calls in flight grows with arrival rate times latency, and nothing in the request path would stop it. RPC admission bounds that number. It is on by default with finite limits, and every limit is per worker.

## Two layers

The adapter's `websocket.messageAdmission` (adapter `PROTOCOL.md` section 3.11) is the first layer: it can shed unparsed application frames before they reach the `message` hook, by rate, bytes and concurrency, and answers with a `message-overloaded` frame. Its ceilings are off until configured, and svelte-realtime inherits it without any code.

RPC admission is the second layer. It runs inside `handleRpc` after the frame parsed and its path resolved to a registered function, so it can bound each function separately and answer on the call's own reply envelope. It uses the adapter's vocabulary: the reasons are `concurrency_limit` and `queue_full`, every limit is per worker, and a limit of `0` is disabled.

## Limits

| Option | Default | Bounds |
|---|---|---|
| `perConnectionConcurrent` | `32` | Calls one connection runs at once, across all functions |
| `perConnectionQueue` | `32` | Calls of one connection waiting in the queue |
| `perRouteConcurrent` | `256` | Calls of one function running at once |
| `globalConcurrent` | `1024` | Calls the worker runs at once |
| `maxQueue` | `256` | Calls waiting for a place, in one queue shared by the worker |
| `timeout` | `30000` | Milliseconds from a call's arrival to its deadline |

```js
// src/hooks.ws.js
import { realtime } from 'svelte-realtime/server';

export const { open, close, message, unsubscribe, init, shutdown } = realtime({
  rpc: { perConnectionConcurrent: 16, maxQueue: 512 }
});
```

Omitted keys keep their defaults. `configureRpc(options)` sets the same limits without `realtime()`, and `configureRpc(null)` restores every default. Raising a limit starts calls already waiting that now fit. Each value must be a non-negative integer (`timeout` at most 2147483647); anything else, including `Infinity`, `NaN`, a negative number or an unknown key, throws at startup. `0` disables a limit: `maxQueue: 0` refuses a call that cannot start at once, `perConnectionQueue: 0` lets one connection use the whole queue, and `timeout: 0` gives calls no deadline.

A function can carry its own bound and budget:

```js
export const search = live(async (ctx, q) => {
  return await searchIndex.query(q, { signal: ctx.abortSignal });
}, { perRouteConcurrent: 8, timeout: 5000 });
```

`perRouteConcurrent` replaces the worker default for that function (`0` removes its bound). Both options are read through wrappers such as `live.validated`, `live.rateLimit` or `live.idempotent`, and `live.stream()` and `live.binary()` accept them too. A function registered under two paths (one export re-exported under another name) is one route: both paths share its bound.

## Timeout: one budget, enforced on both ends

A function's `timeout` is the call's budget. The generated client stub rejects with `TIMEOUT` when it runs out, and the server fires `ctx.abortSignal` for the same call. Each end resolves the budget on its own, from what it can see:

| End | Budget, first that is set |
|---|---|
| Client | `.with({ timeout })` on the call; the function's `timeout`; `configure({ timeout })`; 30000 ms |
| Server | The function's `timeout`; `realtime({ rpc: { timeout } })`; 30000 ms |

So the two ends use the same budget when the function declares `timeout` and the call does not override it, or when `configure({ timeout })` and `rpc.timeout` are equal (both default to 30000 ms). A per-call `.with({ timeout })` changes only the client's budget: the budget is not sent with the call. Calls collected by `batch()` use the batch's timer on the client, `configure({ timeout })`, and their functions' budgets on the server.

The server's signal fires within one 250 ms tick after its budget. A handler that wants to cut a dependency earlier passes its own shorter budget to it. A handler that must finish a side effect after the client gave up ignores the signal; its place in admission comes back when it settles.

## Admission

A call takes one place in each of three scopes, checked in this order: its connection, its function, the worker. When all three have room it starts at once. When one is full it waits in the queue, oldest first; a call further back starts first only when the calls ahead of it are still blocked and it is not. A place comes back when the handler settles, success or failure, and the queue moves on.

A call is refused at once, never after a timeout:

- `queue_full` with `scope: 'connection'` when its connection already has `perConnectionQueue` calls waiting, so one connection holds at most 32 running and 32 waiting calls per worker by default.
- `queue_full` with `scope: 'global'` when the queue already holds `maxQueue` calls.
- `concurrency_limit` when the queue is disabled, with the `scope` that was full: `connection`, `route` or `global`.
- `concurrency_limit` with the scope that is still full, when a queued call reaches its deadline before a place frees. Its message is `The call waited past its deadline`.

A refused call runs nothing and holds nothing: no guard, no middleware, no handler. It is not kept for a later retry. The reply is the usual failure envelope with two more fields:

```json
{ "id": "17", "ok": false, "code": "OVERLOADED", "error": "The call queue is full", "reason": "queue_full", "scope": "global" }
```

On the client it rejects with `RpcError` code `OVERLOADED` carrying `reason` and `scope`. Retry only calls that are safe to repeat, after a backoff; an idempotency key makes a mutation safe to repeat.

## What counts

- RPC calls, binary calls and each entry of a `batch()` take places, and each is admitted or refused on its own. A parallel batch of 50 calls from one connection runs 32 and queues the rest. A refused entry of a sequential batch fails like any other failing entry, and the batch goes on with the next one.
- An oversized batch takes one place for the rejected envelope, without walking its entries or resolving handlers. The configured `beforeExecute` hook sees `('__batch__', [])` once; admission or hook refusal returns one bounded error. Otherwise the reply on `__rpc` / `__batch` has `ok: false` and `code: 'INVALID_REQUEST'`, with no per-call result array. The place stays occupied until the hook settles, and graceful shutdown waits for it.
- A fire-and-forget call (`.fireAndForget()`, no `id`) takes a place too. When it is refused nothing is sent back, but it is counted like any other refusal.
- A stream subscribe holds its place while the stream subscribes and loads, and gives it back once the subscribe is answered, never for the life of the subscription.
- Uploads keep their own limits (`maxConcurrentPerSession`, `maxConcurrentTotal`, the pending byte cap) and take no RPC place.
- Server-side calls (`__directCall` from a `load` function), cron jobs, effects and loader re-runs are not wire calls and are not admitted.

## `ctx.abortSignal`

Every wire call has its own `ctx.abortSignal`. It fires:

- at the call's deadline, its server budget counted from its arrival, with `LiveError('TIMEOUT')` as its reason;
- when the call's connection closes, with `LiveError('CONNECTION_CLOSED')` as its reason.

It never fires after the call settled, so a listener added for a rollback or a cleanup runs only for a call that was cut off. Pass it to anything that can stop early: `fetch(url, { signal: ctx.abortSignal })`, a database driver, `ctx.abortSignal.throwIfAborted()` between steps. A handler that throws the signal's reason answers the caller with that code.

The deadline does not answer the call by itself, and a handler's place goes back only when the handler settles, never when the signal fires. A handler that ignores its signal keeps holding its own place, so it bounds itself; it never holds anyone else's.

The signal's controller is created when the handler first reads `ctx.abortSignal`, so a handler that never reads it allocates nothing for it. A handler that first reads it after its deadline or its connection's close gets a signal that has already fired. Deadlines are checked on a 250 ms tick that runs only while calls run, wait or hold a deadline.

Work that is not a wire call gets a `ctx.abortSignal` that never fires, so code can pass it unconditionally. A loader that runs again for `invalidateOn` or `staleAfterMs` gets such a signal too, since the subscribe's deadline does not bound it.

`ctx` is an instance of the internal `LiveCallContext` class, not a plain object, and `abortSignal` is an accessor on it. Pass `ctx` itself to helpers. Spreading it (`{ ...ctx }`) copies only its own data fields, not `abortSignal` or any accessor added later; a copy that needs the signal sets it explicitly. `live.lock` hands its handler such a copy with the signal carried over.

Admission keeps each connection's record on its socket's user data, which uWS and the adapter give every socket as its own copy. A user data object built on another live socket's user data (through its prototype, with `Object.create`) is not supported: a socket that skips the open hook would share that socket's record.

When a connection closes, its queued calls are dropped (they end as `CONNECTION_CLOSED`, which nobody receives) and its running calls see their signal fire. Running calls keep their places until their handlers settle.

## Client cap

The client bounds its side too. `configure({ rpc: { maxPending } })` (default `256`) is the number of calls, RPC, binary and batched, that may await a response on the connection. One more call rejects at once with `RpcError('OVERLOADED')`, `reason: 'concurrency_limit'`, `scope: 'client'`, and is not sent; it does not wait for a place, and DevTools shows it as a failed call. Inside `batch()` only the refused call fails; the rest of the batch is sent. A place frees when a call is answered, times out, or fails with its connection. Stream subscribes, uploads and replays from the offline queue do not count, and a replay is never refused by this cap. `0` disables it.

## Metrics

With `live.metrics(registry)` installed:

- a refusal counts in `svelte_realtime_rpc_total` with status `error` and in `svelte_realtime_rpc_errors_total` with code `OVERLOADED`, like any other error code;
- `svelte_realtime_rpc_overloaded_total{path, reason, scope}` counts refusals by the limit that refused them, like the adapter's `ws_message_admission_rejected_total{reason, scope}`;
- `svelte_realtime_rpc_inflight{path}` is the number of calls of each function running in this worker;
- `svelte_realtime_rpc_queued{path}` is the number of its calls waiting in the queue.

The gauges are sampled once a second and written with `set` only when a value changed, so a call moves counters and never writes a metric. `path` is always a registered function path, never a client-supplied one, so the series stay bounded by the functions you declare; paths longer than 96 characters fold into `__toolong__`, and the gauges add up the routes under it. Sum them across workers for a process view.

## Sizing

The defaults are far above what a healthy worker runs, and they only bind when a dependency stalls. When refusals appear, read `svelte_realtime_rpc_inflight` first: the function holding the places is usually the one waiting on a slow database, queue or remote API. Bound that function with `perRouteConcurrent` and a `timeout`, and pass `ctx.abortSignal` down, so one slow dependency cannot take the places of every other function. Raise `globalConcurrent` only when the worker has memory and CPU for more concurrent work.
