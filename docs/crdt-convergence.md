# CRDT convergence checks

`runCrdtConvergence` from `svelte-realtime/sim` runs genuine concurrent Yjs edits
through the installed native adapter and the production `live.doc` handlers.
Run it in an isolated Node 22 or newer process after installing the package's
normal adapter peer and its native runtime. It opens ephemeral loopback
WebSocket connections and needs no database or external service. The native test
listener binds according to the installed adapter; its oracle WebSocket route
uses a random per-run path and rejects every non-loopback peer using the
transport's remote address, without trusting forwarding headers. Await runs sequentially;
the runner owns its local document registrations and server lifecycle.

```js
import { runCrdtConvergence } from 'svelte-realtime/sim';

const result = await runCrdtConvergence({
  seed: 'documents-42',
  replicas: 3,
  operations: 48,
  fault: 'reorder-duplicate'
});
if (!result.ok) throw new Error(JSON.stringify(result.failures));
console.log(result.seed, result.executed, result.digest, result.provenance);
```

Each transaction edits a map, an array and text. Map writers also contend on
one shared key; fixed distinct actor IDs make the winning concurrent writer
independently predictable. Older per-writer entries are deleted as edits
continue, so delivery includes causal dependencies and deletion records.
Writers generate their transactions before seeing each other's edits.

The runner sends those encoded updates through real document RPCs and captures
the server's actual WebSocket fan-out. It then applies reordered and duplicated
frames to each client replica. A separate plain operation ledger determines
the full expected map, array and text state; it does not obtain expected state
by replaying Yjs updates. Fixed actor IDs order concurrent writers' retained
append sequences and locally reversed prepend sequences. Every client and the
server's full-state sync reply must satisfy that complete ordered ledger, as
well as agree with every replica. Agreement alone cannot hide a server that
forwarded updates without merging them or a uniform ordering error.

| Option | Default | Contract |
| --- | --- | --- |
| `seed` | `'realtime-crdt-0'` | String or number; reproduces transactions and delivery order. |
| `replicas` | `3` | Integer from 2 to 8. |
| `operations` | `48` | Integer from `replicas` to 512; actual executed transactions. |
| `fault` | `'reorder-duplicate'` | `'ordered'`, `'reorder-duplicate'`, `'drop-update'` or `'corrupt-update'`. |

`drop-update` and `corrupt-update` deliberately lose the final transaction at
its server boundary. They are negative controls and must return `ok: false`.
The normal ordered and reordered/duplicated modes must return `ok: true`.
Infrastructure failures reject the promise; they are never counted as completed
runs or convergence successes.

The result reports `seed`, `fault`, `executed`, `generatedUpdates`,
`updateRequests`, received `deliveries`, faulted attempts, per-replica failures,
the expected ledger, actual states and a reproducible `digest`. `executed`
advances after each transaction; it is not a requested count copied into a
report. Update requests and deliveries are counted at their actual boundaries.
`provenance` records package versions, Node version, the loaded adapter/Yjs
entry hashes and hashes of the runner, document handler and dispatcher source.
It contains no absolute workstation paths. Those hashes identify the inspected
files; they are not a release signature or a claim that local source is published.

Run the native regression suite with
`npx vitest run test/crdt-oracle.test.js`. It checks repeated seeds, actual
execution and fan-out counts, independent final state and both negative modes.
The I/O budgets remain a separate repository suite,
`test/io-budget.adapter.test.js`.
