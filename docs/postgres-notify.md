# PostgreSQL notification lifecycle

The notification bridge turns PostgreSQL LISTEN/NOTIFY messages into realtime publishes. The [README setup](../README.md#postgres-notify) initializes it in the adapter's awaited `init({ platform })` hook. Await `notify.activate(platform)` before accepting WebSocket traffic so a connection or LISTEN setup failure rejects startup.

Use a direct database DSN or a proxy configured for session pooling. Transaction and statement pooling cannot preserve LISTEN subscriptions or session-scoped advisory locks. If ordinary queries use a transaction-pooled route, give the bridge a separate direct/session DSN alongside the external query pool.

Each active bridge reserves one standalone database session outside `pool.max`. With N replicas and B bridges per replica, budget N x B additional sessions in both `multiListener: 'all'` and `'advisory'` modes. Advisory election limits active listeners to the lock owner, while every follower retains its own session to attempt the lock. Include these sessions, query pools, migrations and administrative connections in the server and proxy connection budgets.

In advisory mode with a Redis bus, first await `bus.activate(platform)`, then await `notify.activate(bus.wrap(platform))`. Activation resolves for a healthy advisory follower as well as the listener; connection and setup failures reject. Concurrent activation calls share startup work. Notifications sent before LISTEN is established or during a disconnection are not durable and cannot be replayed by the bridge. Applications needing durable recovery must keep their own durable event source or refresh their current database snapshot.

An owned `createPgClient({ connectionString })` stops registered bridges, cancels retry and election timers, closes tracked standalone sessions, then closes its pool. `await pg.end()` waits for that cleanup. The existing `sveltekit:shutdown` registration performs the same cleanup unless `autoShutdown: false` was configured. `await notify.deactivate()` stops only the bridge and waits for its dedicated session to close.

An externally supplied pool stays caller-owned: the wrapper's `end()` is a no-op, including for standalone sessions. In the application's shutdown hook, await every `notify.deactivate()` and the `end()` of each manually created standalone client before calling and awaiting the external `pool.end()`. Release every checked-out pool lease as well. Closing the query pool alone does not stop standalone bridge sessions.
