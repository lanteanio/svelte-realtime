# RPC admission

Every wire call a worker accepts holds memory until its handler settles: the parsed arguments, the `ctx`, the pending promise and the client's own entry waiting for the reply. When a dependency slows down, the number of calls in flight grows with arrival rate times latency, and nothing in the request path would stop it. RPC admission bounds that number. It is on by default with finite limits, and every limit is per worker.

## Two layers

The adapter's `websocket.messageAdmission` (adapter `PROTOCOL.md` section 3.11) is the first layer: it can shed unparsed application frames before they reach the `message` hook, by rate, bytes and concurrency, and answers with a `message-overloaded` frame. Its ceilings are off until configured, and svelte-realtime inherits it without any code.

RPC admission is the second layer. It runs inside `handleRpc` after the frame parsed and its path resolved to a registered function, so it can bound each function separately and answer on the call's own reply envelope. It uses the adapter's vocabulary: the reasons are `concurrency_limit` and `queue_full`, every limit is per worker, and a limit of `0` is disabled.

## Limits

| Option | Default | Bounds |
|---|---|---|
| `perConnectionConcurrent` | `32` | Calls one connection runs at once, across all functions |
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

Omitted keys keep their defaults. `configureRpc(options)` sets the same limits without `realtime()`, and `configureRpc(null)` restores every default. Each value must be a non-negative integer (`timeout` at most 2147483647); anything else, including `Infinity`, `NaN`, a negative number or an unknown key, throws at startup. `0` disables a limit: `maxQueue: 0` refuses a call that cannot start at once, and `timeout: 0` gives calls no deadline.

A function can carry its own bound and deadline:

```js
export const search = live(async (ctx, q) => {
  return await searchIndex.query(q, { signal: ctx.abortSignal });
}, { perRouteConcurrent: 8, timeout: 5000 });
```

`perRouteConcurrent` replaces the worker default for that function (`0` removes its bound). `timeout` is the same option that sets the client's budget for the call, so the client and the server stop waiting at the same moment. Both options are read through wrappers such as `live.validated`, `live.rateLimit` or `live.idempotent`, and `live.stream()` and `live.binary()` accept `perRouteConcurrent` too.

## Admission

A call takes one place in each of three scopes, checked in this order: its connection, its function, the worker. When all three have room it starts at once. When one is full it waits in the queue, oldest first; a call further back starts first only when the calls ahead of it are still blocked and it is not. A place comes back when the handler settles, success or failure, and the queue moves on.

A call is refused at once, never after a timeout:

- `queue_full` when the queue already holds `maxQueue` calls. The queue belongs to the worker, so its `scope` is `global`.
- `concurrency_limit` when the queue is disabled, with the `scope` that was full: `connection`, `route` or `global`.
- `concurrency_limit` with the scope it waited on, when a queued call reaches its deadline before a place frees. Its message is `The call waited past its deadline`.

A refused call runs nothing and holds nothing: no guard, no middleware, no handler. It is not kept for a later retry. The reply is the usual failure envelope with two more fields:

```json
{ "id": "17", "ok": false, "code": "OVERLOADED", "error": "The call queue is full", "reason": "queue_full", "scope": "global" }
```

On the client it rejects with `RpcError` code `OVERLOADED` carrying `reason` and `scope`. Retry only calls that are safe to repeat, after a backoff; an idempotency key makes a mutation safe to repeat.

## What counts

- RPC calls, binary calls and each entry of a `batch()` take places. A parallel batch of 50 calls from one connection runs 32 and queues the rest.
- A fire-and-forget call (`.fireAndForget()`, no `id`) takes a place too. When it is refused nothing is sent back, but it is counted like any other refusal.
- A stream subscribe holds its place while the stream subscribes and loads, and gives it back once the subscribe is answered, never for the life of the subscription.
- Uploads keep their own limits (`maxConcurrentPerSession`, `maxConcurrentTotal`, the pending byte cap) and take no RPC place.
- Server-side calls (`__directCall` from a `load` function), cron jobs, effects and loader re-runs are not wire calls and are not admitted.

## Deadline and `ctx.abortSignal`

Every wire call gets `ctx.abortSignal`. It fires:

- at the call's deadline, the function's `timeout` or else `rpc.timeout`, counted from the call's arrival, with `LiveError('TIMEOUT')` as its reason;
- when the call's connection closes, with `LiveError('CONNECTION_CLOSED')` as its reason.

Pass it to anything that can stop early: `fetch(url, { signal: ctx.abortSignal })`, a database driver, `ctx.abortSignal.throwIfAborted()` between steps. A handler that throws the signal's reason answers the caller with that code.

The deadline does not answer the call by itself, and a handler's place goes back only when the handler settles, never when the signal fires. A handler that ignores its signal keeps holding its own place, so it bounds itself; it never holds anyone else's. Deadlines have a 250 ms resolution: the signal fires within 250 ms after the deadline. Calls of one connection that share a deadline window share one signal, so an unsaturated call allocates nothing for it.

Work that is not a wire call gets a `ctx.abortSignal` that never fires, so code can pass it unconditionally. A loader that runs again for `invalidateOn` or `staleAfterMs` gets such a signal too, since the subscribe's deadline does not bound it.

When a connection closes, its queued calls are dropped without a reply and its running calls see their signal fire. Running calls keep their places until their handlers settle.

## Client cap

The client bounds its side too. `configure({ rpc: { maxPending } })` (default `256`) is the number of calls, RPC, binary and batched, that may await a response on the connection. One more call rejects at once with `RpcError('OVERLOADED')`, `reason: 'concurrency_limit'`, `scope: 'client'`, and is not sent; it does not wait for a place. A place frees when a call is answered, times out, or fails with its connection. Stream subscribes, uploads and the offline queue do not count, and a replay from the offline queue is never refused by this cap. `0` disables it.

## Metrics

With `live.metrics(registry)` installed:

- a refusal counts in `svelte_realtime_rpc_total` with status `error` and in `svelte_realtime_rpc_errors_total` with code `OVERLOADED` and the `reason` and `scope` labels (empty for every other error);
- `svelte_realtime_rpc_inflight{path}` is the number of calls of each function running in this worker;
- `svelte_realtime_rpc_queued{path}` is the number of its calls waiting in the queue.

The gauges are written with `set`, once per microtask in which they change. `path` is always a registered function path, never a client-supplied one, so the series stay bounded by the functions you declare. Sum them across workers for a process view.

## Sizing

The defaults are far above what a healthy worker runs, and they only bind when a dependency stalls. When refusals appear, read `svelte_realtime_rpc_inflight` first: the function holding the places is usually the one waiting on a slow database, queue or remote API. Bound that function with `perRouteConcurrent` and a `timeout`, and pass `ctx.abortSignal` down, so one slow dependency cannot take the places of every other function. Raise `globalConcurrent` only when the worker has memory and CPU for more concurrent work.
