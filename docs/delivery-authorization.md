# Delivery authorization

Stream guards and loaders decide who may subscribe. They run once, at
subscribe time. When access can change while a subscription is open (a role
is demoted, an assignment is removed, a session is revoked), configure
`realtime({ authorizeDelivery })`: the policy runs again for every outbound
message to every recipient (RPC, upload and protocol responses excepted, see
below) and can stop delivery to a connection that lost access.

This option requires svelte-adapter-uws 0.6.0-next.97 or newer, which provides
`platform.authorizeDelivery`. With an older adapter, the `init` hook throws and
the server does not start, so a version mismatch cannot silently drop the
check. Export `init`, or at least `open`, from the same `realtime()` call:
without `init` the policy is installed by the first connection's `open` hook.
If it cannot be installed, every connection is closed with 1011 and a
`delivery-authorization.unavailable` error is logged once. When neither
`init` nor `open` is exported, the first connection to reach realtime's
`message`, `unsubscribe` or `close` hook installs the policy; that
connection was open before any policy existed, so it is closed with 1011 and a
`delivery-authorization.unguarded` error is logged once. Connections first seen
after the install are covered. Frames the adapter sends to a connection before
its first realtime hook (for example after a client subscribe frame) are
checked only once the policy is installed, and without `init` the strict
wire-subscribe check is armed at that point too: export `init`.

The adapter runs one policy per worker. A later `realtime()` call with a
policy replaces the function in place (a dev reload of `hooks.ws` does this),
without reinstalling it; once installed, a call with different
`deliveryAuthorizationOptions` throws, because the adapter's bounds are fixed.
A `realtime()` call without `authorizeDelivery` leaves the policy in place.
Without the option, nothing changes: subscription admission and native
delivery behave as before.

<!-- doc-code: ambient names="db" -->
```js
// src/hooks.ws.js
import { realtime } from 'svelte-realtime/server';

export const { open, close, message, unsubscribe, init, shutdown } = realtime({
  async authorizeDelivery(ctx, delivery) {
    // Read current state; never trust what was true at subscribe time.
    const session = await db.sessions.find(ctx.user?.sessionId);
    if (!session || session.revoked) return false;
    if (delivery.kind === 'request') return true;
    if (delivery.rpc === 'checkin/scans') {
      const [eventId] = delivery.args;
      return db.scanners.isAssigned(ctx.user.id, eventId);
    }
    return delivery.topic === 'announcements';
  }
});
```

## What the policy receives

The callback receives the connection's live context (`ctx.user`, `ctx.ws`,
`ctx.tenantId`, and `ctx.platform`, which is the worker's platform rather than a
per-request view) and a frozen descriptor:

| Field | Meaning |
| --- | --- |
| `kind` | `message` (publishes and sends), `replay` (replayed frames and a stream's replay response), `snapshot` (a stream's initial data inside its RPC response), `request` (`platform.request`). Branch on it first. |
| `topic` | Wire topic, including any tenant prefix. Replay is shown under the topic it replays. `null` for a request, which is addressed to one socket. |
| `event` | Event name, or `null` for a binary frame, a snapshot, or an envelope that names none. |
| `data` | The parsed payload; `undefined` for a binary frame. A replayed frame carries the replay envelope (`{ seq, event, data }` for `msg`, `null` or `{ truncated: true }` for `end`, plus `reqId` when the client asked with one); a replay response carries the array of missed events. |
| `binary` | Whether the frame is binary. |
| `rpc`, `args` | The stream RPC path that admitted `topic` on this connection and a copy of its validated arguments, or `null`. Arrays and plain objects are copied and frozen (a `__proto__` key stays an ordinary key); a `Map`, `Set`, `Date` or binary value is copied afresh for each call that reads `args`; functions, symbols and other class instances are passed by reference. |

Dynamic derived output topics are opaque hashes: identify their resource by
`rpc` and `args` instead of parsing the topic. A topic the connection joined
outside a stream RPC (a raw adapter subscription, signals, and channels a room
or plugin joins itself, such as presence) has `rpc: null`; authorize it by its
exact topic. Requests have `topic: null`; decide them on `event` and
`data`. Deny whatever the policy does not recognize.

RPC results, upload responses and protocol frames are not shown to the
policy: each answers a request that already passed its own guard. Stream
snapshots and replay inside an RPC response are shown, one call per stream
in a batch response.

When several streams on one connection resolve to the same topic, the first
admission names it (`rpc` and `args`) until the connection leaves the topic.
After an unsubscribe, a frame still held for that topic keeps its
attribution; the connection remembers its last 64 retired topics, and a
closed connection forgets all of them.

## Answers and closes

Only a literal `true` admits a message. A synchronous answer delivers inline;
a promise (or any thenable) holds that message and every later frame for the
connection, in order, until it settles. The adapter bounds what a connection
may hold and how long a decision may take:

<!-- doc-code: ambient names="realtime, authorize" -->
```js
realtime({
  authorizeDelivery: authorize,
  deliveryAuthorizationOptions: { maxPendingBytes: 1048576, timeoutMs: 5000 }
});
```

`maxPendingBytes` defaults to the adapter's `websocket.maxBackpressure` and is
counted together with the transport's unflushed bytes; past it a frame is
dropped, or the connection closed when `closeOnBackpressureLimit` is set.
`timeoutMs` (1 to 2147483647, default 5000) bounds each pending decision. The
adapter rejects unknown option keys.

A refusal (`false`) closes the connection with 1013. The bundled client
reconnects after its base delay and subscription admission runs again, so a
guard that still admits a revoked user repeats the refusal on every reconnect:
keep the guards and the policy consistent. A throw, a non-boolean answer or a
timeout closes the connection with 1011. Either way the frames the connection
still held are discarded, the adapter logs a `delivery-authorization.denied`
or `delivery-authorization.failed` diagnostic, and a held `platform.request`
rejects as never sent.

## Scope

The policy runs on the worker that holds the recipient, for every frame the
adapter builds: publishes, batches, coalesced sends, derived streams, replay,
resume flushes, frames relayed from other workers or replicas (Redis bus,
Postgres notification bridge), signals and server requests. Configure it on
every worker; `realtime()` in the shared `hooks.ws` file does that.

The decision covers the state the callback read. A frame already handed to the
transport, kernel buffers and data the client already received cannot be
recalled. Direct `ws.send` and `ws.publish` calls bypass the adapter
and the policy; publish and send through the platform instead.

This is per-delivery authorization, not a notification that access changed:
an idle connection that lost access is closed on its next refused delivery.
With a policy installed, a publish walks every local connection instead of
using the native topic fan-out, so enable it only where access can change
while a subscription is open.
