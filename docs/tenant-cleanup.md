# Tenant cleanup

Stream unsubscribe and close hooks retain the user and tenant admitted for that
subscription, even if the resolver later fails or selects a different tenant.
Their `ctx.publish` takes a logical topic and applies the admitted tenant
namespace. Framework lifecycle hooks retain their already scoped wire topics.

Manually subscribed static streams have no admitted ownership record. If their
user or tenant cannot be resolved on close, their hooks are skipped with a
constant diagnostic. Essential cleanup still aborts active RPC signals, removes
queued calls and drains uploads, smoothed entities, document references and push
registrations. A closed socket cannot borrow another socket's admission record
when application user data is reused.

A failed context does not run application middleware, guards or handlers. The
network response uses `INTERNAL_ERROR` and a generic message; framework
diagnostics omit the rejected tenant value and original resolver error. The
configured server `onError(path, error, ctx)` callback can inspect that error;
`ctx` is `null` when context creation failed. Volatile calls have
no response. Direct `.load()` calls retain their rejection or configured fallback
behavior.

See [multi-tenancy](../README.md#multi-tenancy-livetenant) for resolver setup and
the trusted tenant namespace.
