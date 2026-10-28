# Client timing

## Request budgets

Declare a slow function's default where it is registered:
`export const report = live(buildReport, { timeout: 300_000 })`.

Timeout precedence is `report.with({ timeout })`, then `live(fn, { timeout })`, then
`configure({ timeout })` (30,000 ms by default). `.fresh()` and idempotency-only
`.with()` calls inherit the function budget. Calls inside `batch()` share its batch
timer, `live.binary()` calls use the app-wide timeout, and fire-and-forget calls
have no response timer.

`live.stream(topic, init, { timeout })` applies the same budget to the stream's
subscribe, refetch and `loadMore()` requests, not to the lifetime of the subscription.
`live.upload(fn, { timeout })` gives an upload a total client deadline and sends
the upload cancellation frame on expiry; undeclared uploads have no deadline.
A client timeout does not stop an RPC handler. Upload handlers can observe
cancellation through `ctx.abortSignal`.

The Vite plugin reads budgets without running server code: write an integer from
1 through 2,147,483,647 ms, or a module-local constant holding one (options objects
and spreads may be module-local constants too). A visible `timeout` the build cannot
resolve fails the build. Options built at runtime still work on the server, but
their timeout does not reach the client stub; use `.with()` there.

## Loading indicators

Handle loading in your template:

```svelte
<script>
  import { messages } from '$live/chat';
</script>

{#if $messages === undefined}
  <p>Loading...</p>
{:else}
  {#each $messages as msg (msg.id)}
    <p>{msg.text}</p>
  {/each}
{/if}
```

For delayed attach indicators, observe `store.pending` as described in [stream state](../README.md#error-handling).
