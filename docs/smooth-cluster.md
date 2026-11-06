# Smooth cluster ownership

`platform.smooth` implements the exported `SmoothCluster` interface with
`ownershipVersion: 1`. Deploy compatible coordinators on every worker together;
mixed ownership protocols do not provide fencing. A deployment without
`platform.smooth` keeps the single-instance authority path. A coordinator that
declares another version, or lacks `acquireOwner`, `renewOwner` or
`releaseOwner`, is rejected with an actionable error before acquisition.

## Pre-v1 coordinators

A coordinator that does not declare `ownershipVersion` speaks the pre-v1
contract: `acquireOwner(topic)` and `renewOwner(topic)` resolve `true` or
`false`, and relays carry no epoch. Realtime runs it on the pre-v1 path and logs
one warning per coordinator:

- A tenure starts when `acquireOwner` resolves `true`. It ends when a renewal, or
  the acquisition that every sync on the owner repeats, resolves `false`, when a
  configured clock fence trips, when the instance forgets the topic (it releases
  the lease), or after 2^31-1 ms (about 24.8 days) without a renewal. A failed
  acquisition keeps a working local authority and a failed renewal keeps the
  tenure, so entities keep moving through a coordinator outage.
- A lease answer other than `true` or `false` fails closed with
  [`REALTIME-ERR-SMOOTH-LEASE-ANSWER`](errors.md#realtime-err-smooth-lease-answer)
  and ends a tenure as `false` does: the sync that acquired fails, and an owner
  stops ticking. An object answer usually means a coordinator that implements
  the v1 contract below without declaring `ownershipVersion: 1`.
- Realtime numbers each local tenure itself, so a new tenure still starts with
  fresh command queues and simulation state.
- Received broadcasts are deduplicated per owner instance: a new owner starts a
  new sequence, and an instance continues its own sequence across its tenures.
  This needs an `instanceId` that no other process uses, including a later one
  after a restart. An owner ignores relayed broadcasts. Acknowledgements and
  sync replies are accepted as they arrive.
- Nothing fences a replaced owner. During a takeover, its late broadcasts can
  interleave with the new owner's until it learns it lost the lease.

The Redis coordinator in `svelte-adapter-uws-extensions` up to
`0.6.0-next.65` is a pre-v1 coordinator.

## Lease and epoch

`acquireOwner(topic)` resolves to `{ epoch, leaseMs }` for a live lease or `null`
when another instance owns it. Failures never create an isolated local owner.
`epoch` is a positive canonical decimal string without leading zeros. It is never
converted to a JavaScript number: compare its length, then its characters. The
backend atomically mints a strictly greater epoch for every new tenure of a
logical topic, including a reacquisition by the same instance. The epoch counter
must survive lease expiry, release, snapshot expiry, process restart, and backend
recovery. A renewed existing tenure keeps its epoch.

`leaseMs` is a positive safe integer duration guaranteed by the coordinator.
Realtime sets its local deadline to the monotonic time immediately before the
call plus `leaseMs`; waiting for the backend or a snapshot consumes this budget.
An already-expired reply is unusable. The backend must not grant another tenure
before this guaranteed duration has elapsed, except after an explicit conditional
release. Its lease clock must not expire earlier than the caller's monotonic
duration clock. A backend failover must preserve both this guarantee and the
epoch counter; a store that can lose acknowledged leases needs a stronger lease
authority before advertising this capability.

`renewOwner(topic, epoch)` atomically extends only that instance's matching LIVE
lease and returns the same shape and epoch, or `null`. It must not recreate an
expired lease. Realtime starts renewals before draining, at most every three
seconds or one third of the granted duration. A renewal reply extends ownership
only while the original local lease is still valid. Failure, a higher observed
epoch, or expiry permanently fences that tenure. Late replies cannot revive it
or affect a subsequent acquisition.

`releaseOwner(topic, epoch)` conditionally releases only the matching instance
and epoch. Realtime relinquishes local ownership before invoking it. An old
queued release must never delete a replacement's lease. A new acquisition clears
old command queues and simulation history; clients rebind using the configured
snapshot or their declared initial state.

## Authoritative transport

The final argument is the epoch on `relayBroadcast`, `relayAck`, `sendSyncReply`,
and `writeSnapshot`. The backend must atomically compare the publishing instance,
epoch, and unexpired lease at the actual publish or write operation. Enqueue-time
validation is insufficient: buffered commands may execute after a disconnect or
takeover. A failed condition drops the operation. Transport must not replay an
unchecked publish or write from an offline queue. For Redis, the lease check and
publish/write belong in the same atomic backend operation and compatible key
slot; resolving a publish node before an unconditional `PUBLISH` is insufficient.

`onBroadcast(topic, event, data, excludeIdentity, sequence, ownerInstance, epoch)`
receives the original epoch and sequence unchanged. Base and cell topics share
one owner lease, epoch, ordered transport, and sequence counter per logical
topic. For example, `__smoothcell:room#0,0` uses the lease for `__smooth:room`.
Sequences are nonnegative safe integers. The receiver shares one watermark across
both topic families, rejects lower epochs and duplicate/regressing sequences,
and resets the sequence only for a greater epoch. Changing instance identity
alone cannot reopen a sequence range. The same epoch cannot name two owners.

`onAck(topic, identity, payload, epoch)` and
`onSyncReply(topic, correlation, payload, epoch)` also reject lower epochs. Their
epoch is transport metadata; it does not change client state, acknowledgement,
event, or snapshot shapes. Snapshot reads return the last conditionally committed
state. Snapshot writes from expired owners cannot overwrite that state.

To resume state after an owner crash, pass `snapshot: true` to `live.smooth()` and
provide both snapshot methods. The owner writes a debounced snapshot, and the new
owner restores it before answering sync requests. `snapshotDebounceMs` controls
the write cadence (default 1000 ms). Without snapshots, takeover starts each
entity from its declared initial state.

Commands, sync requests, leaves, and shots are requests to the current owner.
They retain their existing argument order. The owner checks its local lease
before accepting them, before draining, and again before every local or relayed
update, acknowledgement, event, removal, and snapshot write. Application callbacks
and wire packing can consume a lease, so emission checks run after that work too.
Asynchronous shot callbacks retain their original tenure and cannot inject into
or publish from a later one. Sync replies retain their ownership condition through
middleware and single or batch RPC dispatch; it is checked immediately before the
actual response send. An older sync basis fails with `UNAVAILABLE`. A configured
clock fence also relinquishes ownership.

The executable coverage is in `test/smooth-ownership.test.js` and the real
WebSocket takeover scenario in `test/smooth-idle-join.test.js`.
