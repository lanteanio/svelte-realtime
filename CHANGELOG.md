# Changelog

All notable changes to `svelte-realtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0-next.19] - 2026-06-21

### Fixed

- **A lag-compensated shot now decides which targets were hittable at the instant the shooter fired, not at the instant the shot arrived.** `live.smooth({ hitTest })` rewinds each candidate to the shooter's render-time, but it previously drew the candidate SET from the shooter's area-of-interest membership at receipt - a moment later. Two errors followed when a target crossed the area-of-interest boundary during the shot's brief flight: a target that drifted OUT was dropped though the shooter had it on screen when firing (a hit the player earned, silently missed), and a target that drifted IN only after the shot was fired could be struck though it was never on the shooter's screen then. Membership is now evaluated geometrically at the rewind instant - a target is a candidate only if it was within the shooter's interest radius when fired, measured from the same rewound history the hit test already uses - so both the missed hit and the over-permissive hit are corrected, with no extra per-entity memory. You still cannot hit what was never replicated to you; the gate is just evaluated at the right time. Off by default and byte-identical when `hitTest` is off.

## [0.6.0-next.18] - 2026-06-21

### Fixed

- **A lag-compensated shot can no longer register a "phantom" hit between a dead and a respawned entity.** The rewind history records a position every tick; when an entity dies (or is removed and respawns, often reusing its key) its history has a gap across the dead interval. A rewind landing in that gap previously interpolated a position along the straight line from the corpse to the respawn point - somewhere the entity never was - and could resolve a hit there. The ring now marks any record that resumes after a gap (more than ~2 ticks) as a discontinuity, and a rewind whose bracketing pair spans it misses. Always on and distance-independent, so it covers the respawn case the optional `hitTest.teleportThreshold` distance guard (off by default) does not. Off-path unchanged.

## [0.6.0-next.17] - 2026-06-21

### Changed

- **`live.smooth({ hitTest })` now bounds each shot's rewind to the shooter's server-measured latency, and defaults to a competitive rewind window.** Previously a shot rewound to the client's proposed render-time clamped only to a flat `maxRewindMs`. The server now derives a per-connection rewind window from latency it measures itself: the client echoes a server-authored stamp on the shot (`ackT`, requires `svelte-adapter-uws >= 0.6.0-next.29`), the server computes the round trip as `now - ackT` (both ends server wall times), and tracks the recent maximum (the favor-the-shooter reach, so a latency spike never clamps an honest hit) and minimum (an un-inflatable floor). The shot's render-time is the proposal of WHERE in time to rewind; the server bounds HOW WIDE the window may be - a client can inflate its measured latency only by genuinely lagging (which costs responsiveness), never fake a lower one, so a low-latency shooter can no longer borrow a laggy player's rewind budget. A replayed render-time (a captured shot resent to re-resolve an old enemy lineup) is rejected: render-time only advances per connection. **The `maxRewindMs` default changes from 1000ms to 100ms** - competitive and defender-friendly, suited to a ~60Hz topic: it fully compensates good connections (uplink plus the interpolation delay) while bounding the "shot around the corner" the defender eats to about one body-width at fast-game speeds. Raise it to favor the shooter or to support a high-ping community; keep it at or above one interpolation delay (~`2 x tickMs`). Off by default and byte-identical when `hitTest` is off; without the adapter `ackT` echo it degrades to the flat `maxRewindMs` clamp.

## [0.6.0-next.16] - 2026-06-21

### Added

- **`live.smooth({ hitTest })`: server-rewind lag compensation - a shot hits where the shooter saw the target, not where it has since moved.** Declare a `hitTest` on a smoothed topic and the framework resolves shots authoritatively against the rewound world: when a client calls `view.shoot(cmd)`, the server rewinds every candidate entity to the instant the shooter rendered it (the client's synced-clock render-time, clamped to a `maxRewindMs` window), tests the shot against those historical positions, and applies the result - removing the "I hit them on my screen but missed" that latency causes, without a bit-exact cross-host determinism contract. The declarative path owns broadphase plus narrowphase: give a `hitbox` (`{ shape:'circle', radius }` or `{ shape:'aabb', w, h }`) and a `shot` (`{ type:'ray', origin, dir, maxDist }`) and the framework emits a structured hit; or supply a `resolve(shot, target, ctx)` for a custom narrowphase (the rewound `target.state` carries the time-correct stance, so a crouch hitbox is honored) while the framework still owns the rewind and the candidate gate. `onHit(ctx, target, info)` runs nearest-first (penetration off unless you return without `{ stop: true }`); inside it `ctx.applyTo(victimKey, cmd)` applies an authoritative cross-entity mutation (a hit dropping the victim's health - a server-initiated, non-acknowledged update the victim still receives, so its own prediction is undisturbed) and `ctx.emitEvent(type, data, opts)` signals the hit on the existing `view.onEvent` channel. The candidate set is the area-of-interest relevancy (so `hitTest` requires `interest`): you cannot rewind or hit an entity that was never replicated to the shooter, and the set is server-computed - a client cannot widen it. The rewind never extrapolates and aborts for an entity whose path straddles a teleport (a respawn never resolves a shot against the post-warp position); a hostile or out-of-window render-time fails safe to the current position. The client's `view.shoot(cmd)` is fire-and-forget and bypasses the prediction ring; the hit arrives as a discrete `view.onEvent`. **Off by default and gated end to end on `hitTest`**, so the broadcast hot path and the wire are byte-identical when it is off. Single-instance and on a cluster topic's owning instance today (a non-owner shooter's shot is inert until the cross-instance forward lands). Requires `svelte-adapter-uws >= 0.6.0-next.28`.

## [0.6.0-next.15] - 2026-06-21

### Changed

- **Internal: the server-side lag-compensation foundation for `live.smooth()` (off by default, no public surface yet).** Groundwork for resolving a shot against where a target actually was on the shooter's screen, rather than where it has since moved to. A per-entity position-history ring records each entity's authoritative position every tick (extracted scalar coordinates plus a snap-to-previous state reference, so a rewind reads the time-correct stance while the framework only ever interpolates position); a rewind read bracket-interpolates between the two surrounding records, never extrapolates, fails safe to the current position outside its window, and aborts for an entity whose path straddles a teleport (a respawn must never resolve a shot against the post-warp position). The candidate set for a rewind is gated by the existing area-of-interest relevancy - you cannot rewind or hit an entity that was never replicated to you - so the security boundary is the same set that already governs delivery. The ring is fed each authoritative tick and dropped at every entity-removal site, and is entirely inert unless a topic opts in: the broadcast hot path and the wire are byte-identical when it is off. The public hit-resolution surface builds on this in a later release.

## [0.6.0-next.14] - 2026-06-20

### Added

- **`view.reportCenter(x, y)` / `view.clearCenter()`: a free-cam override for area-of-interest culling.** A `live.smooth({ interest })` topic culls each subscriber around its own entity by default. That is right for a player driving an avatar, wrong for a spectator or a free-cam whose view is somewhere else entirely - centred on its idle entity, such a viewer would be delivered only its own quiet corner instead of the action it is watching. Call `view.reportCenter(x, y)` to point culling at where the camera actually looks (in the topic's position units); the server measures relevance from there until `view.clearCenter()` reverts to the own-entity default. Report it when the camera moves, not every frame - an unchanged center is dropped client-side, and the report rides a volatile send (a lost one is corrected by the next). A reported center takes effect even on a still board (the relevancy pass re-runs on the report, not only on entity motion), so panning across a paused scene reveals what is there. Inert on a topic declared without `interest`. Single-instance and on a cluster topic's owning instance today; a center reported to a non-owning instance is stored but dormant until the cross-instance cull lands (the subscriber keeps its safe whole-relay delivery meanwhile). Realtime-only - no adapter or extensions change.

## [0.6.0-next.13] - 2026-06-20

### Added

- **`live.smooth({ interest })`: area-of-interest culling for an uncapped lobby.** A smoothed topic broadcasts every entity's motion to every subscriber - fine for a 32-player room, ruinous for a lobby of thousands where each client only ever sees its own neighbourhood. Opt into `interest` and the authoritative tick runs a per-subscriber relevancy pass before publishing, so each subscriber is delivered only the entities inside its area of interest instead of the whole board. The two required keys are `interest.radius` (the cull radius, in your position units) and `interest.position(state) => ({x,y}) | null` (where an entity is; `null` means always-visible, like a flag or an objective); the area-of-interest centre is the subscriber's own entity by default, so a player-centric game needs no extra wiring. Optional `interest.lod` is an ascending list of `{ within, rate }` level-of-detail bands - near entities update every tick, fringe entities at a throttled, id-staggered cadence (send every `rate` ticks) so distant motion fades rather than pops, with a small hysteresis margin on the band edges so an entity hovering on a ring does not flicker; an entity entering range, or crossing into a nearer band, is always delivered at once (never a perceptible omission). The relevancy is a delivery preference, never an authorization boundary - the `guard` stays the separate auth layer - and the safety polarity is to over-deliver: a subscriber with no resolvable centre (no own entity and no reported override) is delivered the whole board. **Off by default**, and gated end to end on `interest != null`, so the broadcast-all hot path is byte-identical when interest is off (a benchmark puts the gate overhead within measurement noise, well under 1%). At arena scale (48 entities) the cull delivers roughly 90% less per client, and the saving grows with the population because each client's delivery stays a bounded neighbourhood. Works single-instance and across a Redis-backed cluster: a topic's owner culls its own local subscribers against the full cluster-wide catalog, so a local player still sees nearby remote players. Self-contained - no new adapter or extensions version is required. _Current limits (refinements to follow): the area-of-interest centre is the own-entity position only (the optional spectator / free-cam `smooth-center` override frame is not wired yet), and in a multi-instance cluster a subscriber connected to a non-owning instance is delivered every relayed update (over-delivered, never under-delivered) until the cross-instance fine cull lands._

## [0.6.0-next.12] - 2026-06-20

### Added

- **`live.smooth({ snapshot: true })`: warm-handoff recovery across a cluster failover.** By default a clustered `live.smooth` topic recovers from an owner crash the way a single-instance restart does - the new owner starts a fresh authority and every entity resets to its declared `initial`, which for a game entity means snapping back to spawn. Opt into `snapshot: true` and the topic owner debounce-persists its state (the entity catalog) to Redis while it ticks; when a sibling takes over after the owner dies, it seeds each entity from that snapshot the moment the entity's own client re-syncs, so players resume where they were instead of teleporting. Seeding is lazy by design: a recovered state is applied only when its real client re-binds, so a client that never returns never enters the new authority and nothing leaks. Tune the persistence cadence with `snapshotDebounceMs` (default 1000 - at most that much state is lost on an abrupt crash) and the snapshot's lifetime with the coordinator's `snapshotTtlMs`. Cluster-only (it needs `platform.smooth`) and **off by default**, so the single-instance and default cluster paths stay byte-identical. A rapid second failover before clients finish reconnecting still recovers every entity - the new owner re-persists not-yet-rebound states alongside the live ones - while a client absent past a reconnect grace (~30s) is treated as departed and its entity resets to `initial`. Requires `svelte-adapter-uws-extensions >= 0.6.0-next.20` for the coordinator's `writeSnapshot` / `readSnapshot`.

## [0.6.0-next.11] - 2026-06-20

### Added

- **`live.smooth()` entities now work across a Redis-backed cluster.** Until now smoothed entities were single-instance: behind a load balancer the clients of one topic land on different instances, each runs its own authority, and the same command double-applies while one-shot events double-fire (the [0.6.0-next.10] event-channel note flagged this as the required follow-up). Wire `platform.smooth = createSmoothCluster(redisClient)` from `svelte-adapter-uws-extensions/redis/smooth` and the smoothed-entity layer detects it and routes through it automatically - no application change beyond the one wiring line, and the public surface (`live.smooth()`, the client store, `view.onEvent`) is identical. The model is single-owner-per-topic, because the authority's `apply` step is order-dependent and not idempotent (a converge-everywhere replica like documents would double-apply): exactly one instance holds a per-topic Redis lease and ticks that topic's authority; the other instances forward their clients' command batches to it (one envelope, already-acknowledged ids dropped on arrival) and re-broadcast its updates, acknowledgements, and events to their own local subscribers. Acknowledgements route back to the one instance the commanding client is on; one-shot events carry a per-topic sequence so a redelivered or ownership-overlap-duplicated event is dropped, so cross-instance events now fire exactly once (closing the next.10 cluster gap). On owner death the lease expires, another instance acquires a fresh authority, and clients re-sync - the same recovery a single-instance restart already triggers. Without `platform.smooth` the layer runs single-instance exactly as before (byte-identical wire and lifecycle). Wire it for any multi-instance deployment of smoothed entities. Requires `svelte-adapter-uws-extensions >= 0.6.0-next.19` for the `createSmoothCluster` coordinator.

## [0.6.0-next.10] - 2026-06-19

### Added

- **`view.onEvent` and `ctx.emitEvent`: discrete one-shot events on `live.smooth()` entities.** Smoothing reconciles continuous state, but a muzzle flash, a hit, or a pickup is a fire-once effect, not a position - replaying it as the prediction window reconciles would draw it N times, and broadcasting it back to the owner would draw it twice. The new event channel rides the existing `live.smooth()` surface (no new export, no new `live.*` family): the shared `apply` calls `ctx.emitEvent(type, data, opts?)`, and the component subscribes with `const off = view.onEvent((e) => ...)`. The owner draws the event optimistically the frame its command is issued (`origin:'local'`), suppressed on every reconciliation replay by the same `ctx.firstTime` gate that guards other side effects; the authority broadcasts it author-excluded (it reuses the same `excludeWs` discipline the commanded-update broadcast already uses) so other clients receive it (`origin:'server'`) while the owner never double-draws its own. The optimistic and authoritative copies of one event carry the same `<commandId>:<ordinal>` correlation key, minted identically on both sides, so a handler that receives both can match them. Two `opts` escape hatches: `{ toAuthor: true }` clears author-exclusion (the owner must also receive the authoritative copy - a hit it took), and `{ global: true }` likewise reaches the author (and, once interest culling lands, routes to the base topic). `view.onEvent` returns an unsubscribe and the view fans out one channel consumer to every subscriber; events are not buffered, so subscribe before the first command. The wire is the JSON envelope, additive over the existing `smooth.protocol:1` (a binary event op is a later step), and the SSR view exposes an inert `onEvent` no-op so isomorphic components do not crash. Requires `svelte-adapter-uws >= 0.6.0-next.26`. **Cluster note:** the built-in worker relay carries events cross-worker for free (author-exclusion is instance-local; the relay still fires once), but a Redis-backed multi-instance cluster needs the matching extensions mirror (a required follow-up) before events cross instances.

### Changed

- **BREAKING: the test-authoring subpaths are renamed.** `svelte-realtime/test` is now `svelte-realtime/testing`, and `svelte-realtime/test-client` is now `svelte-realtime/testing/client`. The exported helpers (`createTestEnv`, `createTestContext`, `expectGuardRejects`, `subscribeAt`) are unchanged - only the import specifiers move, disambiguating the framework test helpers from a test runner global `test`. See MIGRATION.md.
- **Internal: all package source moved under `src/`.** Every entry module (`server`, `client`, `vite`, `devtools`, `hooks`, the `client-*` runes, `cli`, the test helpers) and the `shared/` helpers now live under `src/`; the repository root holds only package metadata, docs, and config. The package `exports` map repoints transparently, so every import specifier (`svelte-realtime`, `svelte-realtime/server`, `/client`, `/vite`, `/doc`, `/smooth`, `/multiplayer`, `/devtools`, `/hooks`) is unchanged - a physical relocation only, with no public API change. The determinism guard now ratchets the entire `src/` tree, so any source extracted into new modules is checked automatically.
- **Internal: the server entry is broken into focused modules under `src/server/`.** The error type, validators, runtime fallbacks, shared dev flag, cross-module state, outbound-webhook SSRF/delivery, identity, admission, idempotency, metrics, presence, replay routing, publish helpers, history compensation, the cron parser, the bus/context/reactive core, push notifications, rate limiting, the document and smoothed-entity subsystems, the binary upload pump, the RPC dispatch path, deferred (lazy) registration, dev-mode warnings, the cron scheduling engine, and the `live.X` registration families (feature flags, derived streams, effects, and incremental aggregates; collaborative rooms; multiplayer; the stream circuit breaker; and inbound/outbound webhooks) each now live in their own file. `server.js` retains the `live()` factory, `live.stream`, the thin marker wrappers (`live.channel`/`binary`/`upload`/`middleware`/`access`/`public`/`volatile`/`validated`/`cron`/`gate`/`scoped`), the registry shims, the single subscription-bookkeeping site, lifecycle (`close`/`unsubscribe`), `publish`/`realtime`, the HMR seam, and the wiring that installs the modules - and re-exports the same public surface, so the exported names are byte-identical and there is no API change.

## [0.6.0-next.9] - 2026-06-13

### Added

- **`live.doc()` / `live.map()` / `live.array()`: conflict-free shared documents.** Today `live.stream` is last-writer-wins broadcast: a publish replaces, it does not merge - right for chat, wrong for a shared document where two people edit at once. The new document family adds merge-by-construction shared state: every client holds a local replica, so reads never await the network and the page renders offline; every write applies immediately - `board.map(id).set(key, value)` returns synchronously, the template re-renders against the just-written value in the same tick, and there is no pending state, no optimistic-then-confirmed dance, no rollback; and concurrent edits from any number of peers converge to the same value on every replica without a transform step. Server-side, a declaration looks like any other live export - `export const board = live.doc({ topic, guard, persist })` - and the component constructs its reactive store from the same import: `board.doc(id)` returns named containers (`.map(name)` / `.array(name)` / `.text(name)` - keyed, ordered, and character-level collaborative text over one shared update stream), while `live.map` / `live.array` are the single-container sugar whose store IS the container. Reads are rune-backed and granular (a write to one map key invalidates only readers of that key); multiple components mounting the same document share one replica through a reference-counted cache. Reconnects and offline sessions reconcile through one idempotent state-vector exchange - the server sends exactly what the client lacks, the client uploads exactly what the server lacks - so the local replica IS the offline queue and recovery is independent of how long the client was away; a detected gap (any lost frame, any cause) self-heals through the same exchange. The guard resolves to a per-document `{read, write, comment}` access record: return a boolean and it widens to all three rights, return a partial record and missing rights are false (`{read: true}` is a viewer), and the record is cached per connection per document at sync time - every inbound update is checked against it server-side, a downgrade applies at the next sync, and read-only mounts surface `readOnly` so the UI disables inputs up front (their mutators throw rather than silently fork). The `comment` right is carried in full for the coming rich-text marks surface; granting it changes nothing yet. Durable persistence is two hooks (`persist.load` / `persist.store` - your database calls) on a framework-owned schedule: debounced after the last edit, forced under sustained editing, compacted every N updates, and flushed once when the last subscriber leaves - with concurrent cold joins coalesced onto one load. A failing sync folds into the shared `health` store as `'degraded'` until one succeeds. Updates ride a new reliable no-reply send (`rpc.send(...)`) rather than the volatile tier - a dropped edit would desync the document where a buffered one merely arrives late - and document frames negotiate the binary wire per connection (`crdt.protocol:1`), degrading transparently to JSON envelopes. New `svelte-realtime/doc` subpath (Svelte 5 rune classes `DocHandle` / `DocMap` / `DocList` / `DocText`); requires `svelte-adapter-uws >= 0.6.0-next.25` (an older adapter fails the first use with an actionable version message, never a resolution crash). Documents survive dev-server hot reloads with their unsaved edits intact. **Cluster-aware:** wire `platform.crdt = createCrdtCluster(redisClient)` from `svelte-adapter-uws-extensions/redis/crdt` and the document layer detects it and routes through it automatically - every instance's replica converges via relay, snapshots persist single-writer per topic, and a cold-joining instance pulls the latest from a live peer; without it, documents run single-instance (correct on one process, divergent across a load-balanced cluster - so wire the coordinator for any multi-instance deployment).
- **`.send(...)` on RPC callables: a reliable no-reply send.** The same no-`id` wire frame as `.fireAndForget(...)`, but with no drop tiers: not dropped while offline (the frame queues and flushes FIFO on reconnect) and not dropped under WS backpressure. For one-way sends whose payloads are precious rather than lossy-by-contract.

## [0.6.0-next.8] - 2026-06-12

### Added

- **`live.smooth()`: server-authoritative entities with client-side prediction and reconciliation.** The app writes ONE pure `apply(state, command, ctx)` in a plain shared module; the server declaration runs it on an authoritative tick (default `tickMs: 50`), and the component constructs the view with the same import - `shape.smooth(boardId, { apply, initial })` - so the two sides can never drift. The local entity responds to input on the same frame (`view.command(cmd)` predicts immediately and transmits frame-batched, fire-and-forget commands); the server applies each owner's commands in arrival order and acknowledges with the resulting state; on disagreement the simulation adopts the server's answer instantly while the rendered position eases over `smoothTimeMs` (default 100ms) - corrections below `errorThreshold` (default 1) snap silently. Remote entities render slightly in the past, interpolated between server updates on a server-synced clock (`interpolationMs: 'auto'` tracks the measured update rate). Echo suppression is on by default (`noEcho`): broadcasts of an owner's own commanded updates skip that owner because the acknowledgement already carries the authoritative copy, while `onMissing` motion - which produces no acknowledgement - broadcasts to the owner too. One entity per identity per topic, keyed like presence rosters; entities depart on disconnect; a second tab takes ownership by constructing a view, never by racing commands. Replay safety is part of the contract: `ctx.firstTime` is true only on a command's first application (guard one-shot side effects on it) and `ctx.rng` is a deterministic generator reseeded per command id, identical on prediction, replay, and the server. If the server stops acknowledging past the command-window bounds (`windowCap` 256 / `windowMaxAgeMs` 3000ms), prediction is killed rather than allowed to run away: the view reports `overflowed`, the shared `health` store reads `'degraded'`, and a resync plus the next acknowledgement re-engage it. `view.now()` is the estimated server wall-clock time - the right stamp for `ctx.compensate()` command times, so lag compensation and prediction share one time axis. Binary frames negotiate per connection (`smooth.protocol:1`) and everything degrades additively to JSON. New `svelte-realtime/smooth` subpath (Svelte 5 rune class `SmoothEntity`); requires `svelte-adapter-uws >= 0.6.0-next.24` (an older adapter fails the first use with an actionable version message, never a resolution crash).

## [0.6.0-next.7] - 2026-06-12

### Added

- **Server-side lag compensation for room actions: `history` config + `ctx.compensate()`.** A `live.room()` / `live.multiplayer()` can declare `history: { capture }` - the app's own snapshot function over its authoritative state - and the framework records a bounded per-room-topic ring of snapshots, one after every successful action (`maxEntries` default 300, `maxAgeMs` rewind window default 2000ms, room topics LRU-capped via `maxTopics` default 100; entries are frozen, deeply in dev so accidental mutation throws at the site; entry times are clamped monotonic so a backwards wall-clock step cannot unsort the ring). `capture` receives only the room-identifying arguments - deliberately no ctx, since a snapshot recorded during one user's action is served to every room member's later evaluations - and must return plain data synchronously (a thenable is rejected loudly). Inside those actions, `ctx.compensate(commandTime, (state, meta) => ...)` evaluates against the snapshot recorded at-or-before the client-stamped command time - passed as an ordinary action argument, so there is no wire change and no cost to apps that never use it. Client stamps are honored only inside the window the server itself recorded: an unservable rewind (empty ring, stamp older than the window, nested compensate - including sibling nested calls) fails safe to current state - never the oldest marker - and reports `meta.fallback: true`; `meta.age` reports how far back the rewind reached; a per-call `tolerance` skips the ring lookup for fresh stamps. The eval function is ordinary action code: publishes inside it are delivered immediately, the same semantics as anywhere else in an action, and concurrent `ctx.compensate` calls in one action are safe. Without a `history` config the action path is unchanged and `ctx.compensate` throws a `VALIDATION` error with guidance. Recording a 32-player snapshot measures ~2-4us per action and a ring-hit rewind ~4us on top of dispatch (`NODE_ENV=production node bench/compensate.js`; dev mode reads several times that from the dev-only deep freeze).

## [0.6.0-next.6] - 2026-06-07

### Security

- **`live.webhooks.outbound` ships a complete SSRF defense.** Outbound delivery moves from `fetch` to `node:http`/`node:https` (no new dependency) so the guard controls the whole request, not just the first URL:
  - **DNS rebinding is closed.** In `strict`/`allowlist` mode a DNS-name target is resolved (via `node:dns`, or a custom `resolve` hook), **every** resolved address is range-checked, and the connection is **pinned** to the validated address - so a name that passes the check cannot rebind to a private address before the socket connects. The `Host` header and TLS server name stay the original hostname.
  - **Redirects are followed manually and re-checked on every hop** (up to `maxRedirects`, default 5), with loop detection and refusal of a private/metadata host, a non-http(s) scheme, or an https->http downgrade. (A plain `fetch` would silently follow such a redirect.)
  - **`validateUrl` is now an additional restriction (logical AND), not a replacement** - it can only narrow the allowed set, never re-open a blocked host, runs on every hop, and may be `async`. To reach a specific private endpoint, pair `urlMode: 'off'` (the explicit range opt-out; the http(s) scheme gate still applies) with a `validateUrl` that allows exactly that host.
  - The default `idempotency-key` is **keyed** with your `secret` (HMAC) when set, so it cannot be precomputed from public content; user callbacks are bounded by `callbackTimeoutMs`; the per-attempt `timeoutMs` covers DNS/connect/TTFB/body; retries are jittered; the response body is drained; and failure reports redact URL credentials and never include the secret. New config: `resolve`, `maxRedirects`, `callbackTimeoutMs`.

## [0.6.0-next.5] - 2026-06-07

### Added

- **`live.webhooks.outbound(sources, config)`: fire an outbound HTTP webhook when a topic publishes.** The mirror of the inbound `live.webhook` (now also `live.webhooks.inbound`, with `live.webhook` kept as a permanent alias). An outbound webhook watches `sources` topics and POSTs to an external endpoint on each matching publish - no `+server.js`, no client code. The body defaults to `{ event, data }` (override or skip via `transform`); the target URL is SSRF-checked against private/loopback/metadata ranges (strict by default) at definition time for a static url and again at fire time for a dynamic `(event, data) => url`, loosened via `urlMode: 'allowlist'` / `allow` or a custom `validateUrl`. Delivery is **at-least-once**, leader-gated for clusters: wire `configureCron({ leader })` (the same leader cron uses) so only the leader replica fires; without a leader every worker fires (single-process-correct). Strict exactly-once over HTTP is unachievable, so every POST carries a stable `idempotency-key` header (content-derived; identical across retries and a leadership-transition double-fire) - make receivers idempotent for effectively-once. Each POST is retried with exponential backoff on 5xx / 429 / network errors (a 4xx is permanent, not retried), optionally HMAC-signed (`x-webhook-signature: sha256=...`) when a `secret` is set, with an `onFailure` hook on exhaustion. Server-only; nothing is generated for the client. Requires `svelte-adapter-uws >= 0.6.0-next.15` (the outbound URL guard uses its `safe-url` export).

### Changed

- **The SSRF URL guard is now imported from `svelte-adapter-uws/safe-url`** instead of being a concern of any one extension. (Internal; no public surface change beyond the adapter peer-dependency floor moving to `^0.6.0-next.15`.)

## [0.6.0-next.4] - 2026-06-07

### Added

- **Collaborative field surfaces on `live.multiplayer()` rooms are now live: typing, selections, advisory locks, and reactions.** The room view returned by `board.room(...args)` exposes them as reactive projections and send methods:
  - `room.typing` - the user keys of remote collaborators currently flagged as typing. `room.setTyping(on)` publishes the local flag.
  - `room.selections` - remote selection ranges keyed by user (self excluded). `room.setSelection(range)` publishes the local offset-mode range (`{ start, end, nodePath }`); pass `null` to clear it.
  - `room.locks` - advisory lock holders as a `{ lockKey: holderUserKey }` map. `room.acquireLock(key)` announces a soft, collaborative-awareness claim and `room.releaseLock(key)` clears it; a holder disconnecting drops its claims automatically. These are awareness locks, not distributed mutual exclusion.
  - `room.reactions` - a bounded ring of recent ephemeral emotes. `room.react(token, point?)` emits one. Reactions ride a dedicated stream and are never coalesced, so a burst of taps all arrive.

  Typing, selections, and locks are published onto the room presence roster (the same roster `room.others` reads), so the field views add no extra subscription. Enable a surface by declaring it on the export: `typing: true`, `selections: 'offset'`, `locks: ['title', 'body']`, `reactions: true`. A multiplayer export that declares no field surface generates identical output to before, and a project with no `live.multiplayer` export is unchanged. Calling a field method off the room (on the namespace rather than a `room(...)` instance) remains a safe no-op.

- **Selections and advisory locks now persist on the presence roster, so a late joiner sees them immediately.** A `setSelection(range)` or `acquireLock(key)` is stamped onto the caller's roster entry after the live update is published, so a collaborator who subscribes afterwards loads the current selection and held locks from the roster snapshot instead of waiting for the next change. Clearing a selection (`setSelection(null)`) or releasing a lock (`releaseLock(key)`) removes the field from the entry. This works both single-instance and across a cluster (via `platform.redis`). `typing` stays ephemeral by design: it is a transient flag that never persists.

- **An injectable clock/RNG/timer runtime, surfaced on `ctx` as `ctx.now()` / `ctx.hlc()` / `ctx.random`.** Every wall-clock read, duration measurement, PRNG, UUID, and timer in the server and the browser client now routes through one swappable runtime module (its default binds the native primitives, no measurable cost). Loaders and RPC handlers can read the injectable clock and seeded RNG through `ctx.now()`, `ctx.random` (`{ float, u32, uuid, bytes }`), and `ctx.hlc()` (a hybrid logical clock), which forward the adapter platform's surface with a native fallback when running standalone. The cron tick now reads its date parts through `Intl` in a configurable time zone (default the system zone, so production behavior is unchanged). The browser client uses a browser-backed runtime (Web Crypto + global timers, no Node built-ins). A dependency-free `scripts/check-determinism.js` check, new to this package and wired into `pretest`, keeps raw native time/RNG/timer calls out of the routed source. Strictly additive and zero-config.

### Changed

- **A `live.multiplayer()` export that declares a presence field (`typing`, `locks`, or `selections`) now requires a `presence` function.** A presence field is stamped on a roster entry that only exists once presence is set, so declaring a field without presence is a configuration error - the field would publish live but never persist for a late joiner. This is caught at build time by the Vite plugin and at runtime by `live.multiplayer()`. `reactions` are exempt: they ride their own ephemeral stream and never touch the roster, so a reactions-only export needs no presence.

## [0.6.0-next.3] - 2026-06-06

### Added

- **`live.multiplayer(config)` - bundle live cursors and presence into one collaborative declaration with an aggregated roster.** A dedicated bundler that reuses the same data stream, presence auto-join, cursor stream, and scoped actions as `live.room()` (the data/presence/cursors sub-streams, the presence-ref grace handling, and the room actions are byte-identical), then exposes a connection-aware surface on the client. The generated client export carries the room sub-streams (`data` / `presence` / `cursors`) plus `status` (the connection-status store), the `move` / `reportViewport` cursor methods, `identify(key)`, and a `room(...args)` factory. `move(...args, payload)` and `reportViewport(...args, payload)` are volatile (fire-and-forget) calls that publish a keyed update to the room's cursor sub-topic, so every connected client sees the position on the `cursors` stream.

  `board.room(boardId)` returns a reactive roster view that aggregates the presence and cursor streams into the surface an app renders:
  - `others` - the presence roster deduped by user key (latest wins), each entry stamped with a deterministic color, with the local user excluded once it is known.
  - `cursors` - deduped by user key and colored (the local user is kept so it can render its own cursor).
  - `me` - the local user's key, or `null` until `identify(key)` is called.
  - `status` - the connection-status passthrough.

  The app names the current user once with `board.identify(key)` (the same identity it already supplies for presence, available from the SvelteKit page load). Calling `identify(key)` after `room(...)` lights up `me` and self-exclusion live. If it is never called the surface degrades gracefully: `others` is the full deduped roster and `me` reads `null`, never a crash. The Vite plugin detects the export, registers its sub-streams, cursor handlers, and actions lazily (and eagerly in dev) exactly like a room, generates the client namespace, and renders an empty collaborative state during SSR so a page that reads `board.status`, calls `board.move(...)`, or reads `board.room(...).others` before hydration does not crash. A project with no `live.multiplayer` export generates identical output to before. `MultiplayerConfig` and `MultiplayerExport` types are added to the `live` namespace in `server.d.ts`; the aggregated `MultiplayerRoom` view ships from the `svelte-realtime/multiplayer` subpath.

  ```js
  // src/live/collab.js
  export const board = live.multiplayer({
    topic: (ctx, boardId) => 'board:' + boardId,
    topicArgs: 1,
    init: async (ctx, boardId) => db.cards.forBoard(boardId),
    presence: (ctx) => ({ name: ctx.user.name }),
    cursors: true
  });
  ```

  ```svelte
  <script>
    import { board } from '$live/collab';
    let { data } = $props();        // data.userId from the SvelteKit load
    board.identify(data.userId);    // names self; me + self-exclusion light up
    const room = board.room(boardId);
  </script>

  {#each room.others as person (person.key)}
    <Avatar name={person.name} color={person.color} />
  {/each}
  ```

  The `typing` / `locks` / `selections` / `reactions` views and their methods (`setTyping` / `acquireLock` / `releaseLock` / `setSelection` / `react`) are present so the API shape is stable, but they are inert: the views read empty and the methods are safe no-ops that emit a single dev-mode note. They activate once the client-to-server field send path lands.

- **`colorForKey(key)` / `hueForKey(key)` - deterministic user colors.** Derive a stable color (or raw hue) from a user key with a 32-bit FNV-1a hash kept entirely in unsigned 32-bit space (`Math.imul` + `>>> 0`), so a server render and the first client paint compute the identical color for a key with no hydration mismatch. Exported from `svelte-realtime/client` and re-exported through `svelte-realtime/shared/color.js`. `colorForKey` draws saturation and lightness from a legible band using high bits of the same hash (windows disjoint from the bits the hue consumes), widening the palette from 360 hue-only buckets to 4320 distinct swatches (360 hues x 3 saturation bands x 4 lightness bands) so distinct collaborators are far less likely to share a color, while every swatch keeps a legible foreground contrast. The first band of each set is the original value, so the palette is a strict superset of the previous single band; `hueForKey` is unchanged and still returns the raw hue.

## [0.6.0-next.2] - 2026-06-05

### Changed

- **`realtime.health` now also reflects the connection's own flow-control pressure, not just server-pushed status.** When the underlying adapter connection signals sustained outbound back-pressure, `realtime.health` reports `degraded` (and recovers when it drains), OR-ed with the existing server `degraded` / `recovered` signal so neither input clobbers the other. No new API and no new surface; a connection or adapter without the flow-control signal behaves exactly as before.

## [0.6.0-next.1] - 2026-06-05

### Added

- **Client-side dev-mode publish-rate hint.** The server already warns when a topic publishes faster than the high-frequency threshold (`live.publishRateWarning`, reading `platform.pressure.topPublishers`). The client now mirrors that hint from the receiving side: in development it measures each stream's inbound frame rate at the dispatch hook and logs one warning per topic when it crosses the same threshold (200 events/sec), with the same `coalesceBy` / `volatile` suggestions and the same `https://svti.me/highfreq` link. The hint is suppressed for any stream declared with `coalesceBy` (the user already chose latest-value-wins), and warns at most once per topic per session with a FIFO-evicted dedup set. Silence it everywhere with `configure({ publishRateHint: false })`. The whole feature is gated by the `import.meta.env`-folded dev flag, so a production build dead-code-eliminates it - zero residue on the inbound dispatch path (verified by a production-mode bundle check and the unchanged `bench/onjsonmessage.js` dispatch numbers).

- **`live.flag(topic, initialValue?, options?)` - server-controlled feature flag exposed as a readable client store, cluster-consistent by default.** A flag is a thin wrapper over `live.stream`: it declares a `merge: 'set'` topic carrying the value, and the returned export carries a `.set(value)` method that publishes a new value to every subscriber. On the client, `$live/<module>` is a readable store carrying the current value - import it and read `$flag` like any other stream. `.set(value)` publishes through the framework-owned platform (the same path as the top-level `publish()` helper), so the new value reaches every local subscriber and relays across the cluster when a bus is wired; it requires the platform to have been captured (`realtime().init` / `setCronPlatform` / `_activateDerived`), matching cron and `publish()`. A single-entry shared replay buffer is enabled by default, so `.set()` writes the cluster-shared buffer and a client connecting fresh to any replica - including one that never set the flag locally - is served the cluster-latest value on connect; the fresh-subscribe seeding is gated strictly to flags so non-flag replay streams keep their loader-only fresh-subscribe behavior. An internal watcher on every running replica keeps the cached value fresh from boot within a tick of any inbound `set`, so synchronous `.get()` reflects the cluster-latest value on any running instance. The watcher is installed eagerly when the registry module loads - the same lifecycle that activates `live.effect` watchers - via a generated `__registerFlag(topic, initialValue?)` call keyed by topic, so it catches inbound sets from boot without waiting for the flag module's first local import or subscribe (the flag's stream registration stays lazy; only the watcher install is hoisted to boot). `getLatest()` reads the shared buffer asynchronously for the strict read on a replica that booted after the last `set` and has not yet received any inbound `set` (a flag read the moment a replica boots, before it has seen any traffic; the watcher catches only post-boot sets, `getLatest()` reads the shared buffer). Pass a custom `replay` object to size the buffer, or `{ replay: false }` to opt out - a single-process app loses nothing, since the locally cached value is authoritative in one process. The Vite plugin generates the client stub (a `merge: 'set'` `__stream`), the registry registration (stream + eager `__registerFlag` watcher install), and the `StreamStore` type declaration, mirroring the existing `live.derived` / `live.aggregate` codegen. Types added to the `live` namespace in `server.d.ts`.

  ```js
  // src/live/flags.js
  export const maintenance = live.flag('flag:maintenance', false);
  export const toggleMaintenance = live(async (ctx, on) => { maintenance.set(on); });
  ```

  ```svelte
  <script>
    import { maintenance } from '$live/flags';
  </script>
  {#if $maintenance}<Banner />{/if}
  ```

## [0.5.10] - 2026-05-25

### Fixed

- **`live.push` and `live.notify`: cluster-first lookup when `configurePush({ remoteRegistry })` is configured.** Pre-fix, both delegates short-circuited on the local `_pushRegistry` whenever this instance had any entry for the target userId, even if a later registration on a different instance had become the cluster-canonical owner. Result on a multi-replica deploy with the same user open in multiple tabs across workers: the push routed to whichever tab happened to be on the caller's instance, not to the cluster-canonical (most-recently-opened) tab the documentation already promised. Routing was non-deterministic: the same `live.push({ userId })` call returned different recipients depending on which instance the caller was running on. Post-fix, `live.push` / `live.notify` consult the `remoteRegistry` first when one is configured. The registry's own self-targeting short-circuit (`registry.request`'s `ownerInstanceId === instanceId` fast path in `svelte-adapter-uws-extensions/redis/registry.js`) preserves single-tab performance -- no extra Redis hop when the canonical owner IS this instance. Multi-tab same-user across instances now routes deterministically to the cluster-canonical recipient. The local entry is consulted only as a fallback when `remoteRegistry` rejects with an "offline" error AND the local registry has an entry for the userId (covers the brief propagation race where `pushHooks.open` has populated local + Redis but the cluster pub/sub event hasn't yet applied to this instance's userToInstance index). Updates the three tests that previously codified the local-first behavior (`prefers the local registry over the remote registry...`, the symmetric notify test, `configurePush({ identify, remoteRegistry })`) and adds two new tests covering the propagation-race fallback for both push and notify. Single-instance deployments (no `remoteRegistry` configured) are unaffected -- the local-only path is preserved as-is.

## [0.5.9] - 2026-05-22

### Added

- **`createMessage({ onJsonMessage(ws, msg, platform) })` callback for plugin-layer JSON envelope dispatch.** Plugin frames (cursor `{type:'cursor',...}`, future presence/typing) reach a single callback with the parsed value, so user wiring doesn't re-parse on every frame. Two-tier lookup: (1) fast path uses the parsed `msg` field forwarded by `svelte-adapter-uws` (when prefix matched, parse succeeded, and no control type matched), avoiding a second parse; (2) fallback parses locally for frames the adapter didn't fast-path (older adapter, > 8 KiB frame, or non-`{"ty` prefix). The depth cap `maxJsonDepth` (default 64) mirrors `handleRpc`'s envelope-depth defense; deeper envelopes fall through to `onUnhandled` with raw bytes. No size cap here - the adapter's `maxPayloadLength` (default 1 MB) is the structural ceiling. `onUnhandled` continues to work for binary frames / non-JSON / parse-fail / depth-bust. Existing `createMessage({ onUnhandled })` wiring is unaffected; opt in by replacing `onUnhandled` with `onJsonMessage` where you currently re-parse manually. Type added to `CreateMessageOptions` in `server.d.ts`.

  **Bench (`bench/onjsonmessage.js`, 7 rounds x 50K iterations, median):**
  - small cursor envelope (~60 bytes): 470 -> 66 ns/dispatch, **7.15x speedup**
  - presence-snapshot envelope (~40 bytes): 341 -> 46 ns/dispatch, **7.35x speedup**
  - 400-byte chat-shaped envelope: 828 -> 99 ns/dispatch, **8.35x speedup**

  At cursor scale (1000 movers x 60 Hz = 60K dispatches/sec), the baseline burns ~28 ms/sec on parsing alone; the variant burns ~4 ms/sec. The structural cost saving compounds with every plugin that adds direct-wire frames.

- **`ctx.skip(key, ms)` per-key handler gate primitive on `LiveContext` (`LiveContext.skip` / `CronContext` does not include it - cron handlers don't have a `key` concept since they fire on a schedule, not on per-request input).** Pairs with `ctx.shed` semantically (both return `true` to early-return). Use inside a handler body to drop calls within a per-key cooldown window:

  ```js
  export const moveNote = live(async (ctx, noteId, x, y) => {
    if (ctx.skip(`move:${noteId}`, 16)) return;  // drop calls within 16ms
    await dbUpdateNote(noteId, x, y);
    ctx.publish(TOPICS.notes, 'updated', { noteId, x, y });
  });
  ```

  State is per-replica (CPU/DB shed, not cluster-wide rate limit; for cross-replica gating use `live.rateLimit({ store: 'redis' })`). Capped at `_THROTTLE_DEBOUNCE_MAX` (5000) entries; on overflow the gate fails open (returns `false`, dev-warns once) so a runaway dynamic-key generator cannot silently start blocking legitimate calls. Throws `LiveError('INVALID_ARG', ...)` on `key` not a string or `ms` not a positive finite number (matches `ctx.signal` / `ctx.shed` precedent of throw-on-misuse for new APIs with no back-compat exposure).

- **`ctx.publishThrottled(topic, event, data, ms)` and `ctx.publishDebounced(topic, event, data, ms)` as canonical names for the existing `ctx.throttle` / `ctx.debounce` helpers.** Pre-change, the names "throttle" and "debounce" in JS-land typically mean "gate a function's execution" (lodash, RxJS, Underscore). The realtime helpers actually scheduled outbound publishes - misreading the name as a gate led to calls like `ctx.throttle('move:noteId', 50)` (intending to gate the handler) which silently published garbage at full rate to a topic nobody subscribed to. Renaming to `publishThrottled` / `publishDebounced` puts "publish" central in the name so the misread becomes structurally impossible. Behavior is identical to the old names; same 4-arg shape `(topic: string, event: string, data: any, ms: number)`.

### Changed

- **`ctx.throttle` / `ctx.debounce` soft-deprecated in favour of `ctx.publishThrottled` / `ctx.publishDebounced`.** The old names keep working as aliases with identical behaviour; a one-time dev warning per process points at the new names. The aliases are kept indefinitely (no sunset date) to preserve existing deployments. MIGRATION.md has the rename guidance.

- **`ctx.publishThrottled` / `ctx.publishDebounced` (and the deprecated `throttle` / `debounce` aliases) emit a one-time dev warning per helper name when called with args that don't match the publish-helper shape `(topic: string, event: string, data: any, ms: number > 0)`.** Pre-change, calls like `ctx.throttle('move:id', 50)` (developer thought it was a handler gate) silently passed `event=50` (number), `data=undefined`, `ms=undefined` to `setTimeout` (coerced to 0), publishing junk frames to a non-existent topic at the full client rate. With the new warning, dev sees the issue immediately; production behaviour is unchanged (no throw) so existing deployments don't crash on upgrade. The warning points at `ctx.skip(key, ms)` for the actual gate primitive and `live.rateLimit()` for handler-wide rate limiting.

## [0.5.8] - 2026-05-22

### Added

- **`rpc.fireAndForget(...args)` client-side method + new `configure({ volatileBackpressureBytes })` knob + new `__devtools.volatile` ring buffer.** Pair with the server-side `live.volatile(fn)` marker that landed in the same release. Calling `myRpc.fireAndForget('arg')` sends `{rpc, args}` on the wire (no `id` field) and returns `void` synchronously - no Promise allocation, no dedup-map entry, no pending-Map entry, no timer allocation, no devtools-pending entry. At demo scale (60-120Hz cursor + drag, multiple movers) this removes 100K+ short-lived heap allocations per second on the client side that the existing `__rpc(path)(...)` path would have produced.

  Safety surface:
  - **Offline:** silent no-op while disconnected. `_volatileDropped` ticks; no offline-queue entry is created. Lossy under disconnect IS the contract.
  - **Backpressure (OOM defense):** before send, the client reads `conn.bufferedAmount` from the adapter; if it exceeds `volatileBackpressureBytes` (default `4 * 1024 * 1024` = 4 MB; configurable via `configure({ volatileBackpressureBytes })`), the send is dropped silently and `__devtools.volatileDropped` increments. The default is sized for 120Hz cursor + drag traffic (~24 KB/sec per client on volatile paths): 4 MB gives ~170s of buffer headroom before drops kick in - healthy demos never trip it, but a genuinely stuck connection drops volatile frames before the browser send buffer can OOM. Dev-mode emits a one-shot `console.warn` on first backpressure drop per session so devs notice in development; subsequent drops silently tick the counter.
  - **Inside `batch()`:** dev-mode `throw`, production silent no-op. Volatile bypasses batching by design - the existing `_batchCollector` short-circuit at the top of `__rpc().fireAndForget()` is the detection point.
  - **Terminated connection:** silent no-op (matches the existing `_terminated` guard in `_sendRpc`).

  Devtools: new `__devtools.volatile` ring buffer (100 entries, drop-oldest, `_DEVTOOLS_VOLATILE_MAX`), each entry recording `{path, args, time, seq}`. Send-only - there is no matching completion event because the wire shape carries no `id` and the server never replies. `__devtools.volatileDropped` is a monotonic counter of all dropped sends (offline + backpressure + future drop reasons). Both are bounded so a 120Hz mover cannot anchor unbounded dev-mode memory.

  Module-state additions: `_IS_DEV` (Vite-PROD-aware constant, also true under vitest where `import.meta.env.PROD` is undefined), `_DEFAULT_VOLATILE_BACKPRESSURE_BYTES`, `_volatileDropped`, `_volatileBackpressureWarned`, `_devtoolsVolatileSent(path, args)`, `_devtoolsVolatileIdx`, `_devtoolsVolatileSeq`. `client.d.ts` extends the `__rpc()` proxy shape with `fireAndForget(...args: any[]): void` and the `configure(...)` config type with `volatileBackpressureBytes?: number`.

  10 new tests in `test/client.test.js` cover the wire shape (bare `{rpc, args}`, no id field), return type (undefined), pending-Map non-allocation, devtools ring buffer capture, backpressure drop at default 4 MB, backpressure drop at a configured override, batch() rejection in dev, offline silent drop, one-shot dev warn, and coexistence with normal RPC calls on the same path. The test harness's existing `mockBufferedAmount` knob (already used by the upload backpressure tests) drives the threshold tests.

- **`live.volatile(fn)` server-side marker for fire-and-forget RPC handlers + `handleRpc()` now accepts wire frames with no `id` field as fire-and-forget calls.** Pre-fix, every RPC call carried `{rpc, id, args}` on the wire; the server allocated a response envelope, ran the handler chain, and emitted `{id, ok, data}` back to the client via `_respond()`. For one-way calls - cursor moves, drag updates, typing indicators, telemetry beacons, heartbeats - the response is discarded by the caller, so allocating it (server-side) and the client's pending Map + Promise + timeout (client-side) is pure overhead. At demo scale (1000 movers x 60Hz x 2 hot paths) that overhead crosses 100K allocations/sec on both sides for value that is never read.

  Fix: a wire frame with `rpc` present but `id` absent now routes through a new `_executeVolatileRpc` path. The handler still runs through the full chain (global middleware via `live.middleware`, per-module guards via `__registerGuard`, rate limits via `live.rateLimit` / `live.rateLimits`, validation via `live.validated`, idempotency via `live.idempotent`, locks via `live.lock`, circuit breakers via `live.breaker`, the registry-level rate-limit check inside `_executeSingleRpc`), and metrics still fire via `_recordRpcMetrics` for operational visibility. The single difference is `_respond()` is never called - per the fire-and-forget contract, the caller does not hear back. Errors (auth failures, validation rejections, handler throws) still route through the error path and remain visible to operators in metrics and dev-mode logs; they just never reach the wire.

  The `live.volatile(fn)` marker stamps `fn.__isLive = true` + `fn.__volatileRpc = true` and is the recommended way to declare intent. Per-call fire-and-forget on a non-volatile handler is also accepted - the wire shape (id absent) is the actual contract - and dev-mode emits a one-shot warning per path naming the handler when `__volatileRpc` is not set, so accidental fire-and-forget calls against handlers that have a meaningful return value surface in the server log. The warn dedup is bounded by `_VOLATILE_WARN_CAP = 256` distinct paths to prevent unbounded growth under a script-driven barrage.

  `handleRpc()` ingress safety: a no-id frame with empty `rpc` is rejected with `return false` BEFORE routing to `_executeVolatileRpc` (mirrors the existing `rpc:''` defense for id-bearing frames). A frame with non-string `id` (e.g. `id: 123`) is still rejected with `return false` - only `id === undefined` triggers the volatile branch. The envelope depth cap, args-array check, payload validation, path validation, and binary-RPC guard all still apply. The existing `realtime/handleRpc.envelope.non-empty` assertion still fires for id-bearing frames where either side is empty.

  No protocol bump required - the wire shape is purely additive. Old servers (without this change) see a no-id frame and reject it; the matching client-side `.fireAndForget()` returns void either way, so the worst case is a silent server-side drop, which IS the documented fire-and-forget contract. Apps not using `live.volatile()` see zero behavior change.

  The Vite plugin's client-stub codegen and `.d.ts` typegen detect `live.volatile(...)` exports via a new `VOLATILE_EXPORT_RE` and emit the same `__rpc(...)` stub line as plain `live()` exports (the `.fireAndForget()` method is attached by the `__rpc()` factory itself, so a single codegen path serves both call shapes). Without the codegen change, `import { moveCursor } from '$live/cursors'` would not resolve to a client stub. A new `test/vite.test.js` case pins the contract.

  The dev-mode "not marked volatile" warning walks the `__wrappedFn` chain produced by `live.rateLimit` / `live.idempotent` / `live.breaker` / `live.validated` / `live.lock` (bounded at depth 8), so a `live.rateLimit({...}, live.volatile(handler))` shape does not spuriously warn. New `test/server.test.js` case `'does NOT dev-warn when volatile is wrapped by live.rateLimit'` pins this.

  12 new tests in `test/server.test.js` cover the wire path (no-id frame routes to volatile, response is never sent, dev warn fires once per non-volatile handler, middleware/guards still run, non-volatile handler accepts fire-and-forget too, empty-rpc rejected, non-string-id rejected, wrapped-marker does not warn) plus 3 tests on `live.volatile()` itself (stamps both markers, validates fn argument, returns same reference).

### Changed

- **`batch()` sends a bare RPC frame when only one call was collected, skipping the batch envelope.** Pre-fix, `batch(() => [oneCall()])` always wrote `{batch: [{rpc, id, args}], sequential?}` to the wire and the server responded with `__batch` envelope `{batch: [result]}`. Defensive callers that wrap single writes in `batch()` for API symmetry - or codepaths that conditionally aggregate but happen to collect one call - paid envelope cost on every call. At the wire, a batch-of-1 is semantically identical to a bare RPC: there is no ordering to enforce, no batch-level response shape to consume, and `Promise.all([p])` resolves to `[await p]` either way. Post-fix, when `collected.length === 1`, the client sends the bare `{rpc, id, args}` frame and attaches a per-call timer to the pending entry (collected entries are created with `timer: null` inside the `__rpc` collector branch, so without this the batch-level timer would be the only timeout). The server's existing single-RPC path handles the frame and responds via `_respond(ws, id, ...)` directly - no protocol change. Batches of 2+ keep the existing envelope. Public API unchanged: `batch(fn)` still returns `Promise<any[]>` with results in declaration order and rejection still bubbles through `Promise.all`. Three new tests in `test/client.test.js` cover the bare-frame shape (`sent.rpc` set, `sent.batch` undefined), array-shape preservation on the return value, and rejection propagation through the single-element `Promise.all`. The existing `sequential` flag tests were rewritten to use 2-call batches since `sequential` is meaningless for a single call.

- **Peer dependency `svelte-adapter-uws` floor raised to `^0.5.3` (from `^0.5.1`); dev dependency `svelte-adapter-uws-extensions` floor raised to `^0.5.3` (from `^0.5.1`).** Picks up two coordinated upstream releases:
  - **0.5.2** - cursor plugin wire-format split (`catalog` / `join` roster channel + `update` / `bulk` / `remove` positions channel) so user metadata flows once per (ws, topic) instead of per frame; new `topicThrottle` option (default 16ms) coalesces dirty movers per topic; per-cursor throttle default lowered from 50ms to 16ms; new client-side `move(topic, data)` helper on `svelte-adapter-uws/plugins/cursor/client` that skips the RPC pipeline entirely and coalesces high-DPI mouse traffic via `requestAnimationFrame`. Extensions side: Redis cursor matches the split wire format; HSET writes coalesced onto a 100ms snapshot tick (~100x fewer HSETs at 1000 movers x 60Hz); cross-replica relay decoupled from per-call HSET success.
  - **0.5.3** - `plugins/presence/client.js` sends a `{type:'presence-snapshot', topic}` text frame on every `status === 'open'` (initial + reconnect) so per-board presence self-heals across reconnects, symmetric to the existing `cursor-snapshot` path; matching server-side handler ships in extensions 0.5.3 (`presence.hooks.message` re-emits a `presence_state` to the requesting ws). The adapter also adds an optional `ctx.msg` field on `MessageContext` carrying the pre-parsed JSON envelope from the adapter's control-frame detection - dispatchers wired through `createMessage({ onUnhandled })` no longer pay a second `TextDecoder + JSON.parse` on the same frame (svelte-realtime's `handleRpc` does its own parse on the raw `ArrayBuffer` today; opportunistic adoption of `ctx.msg` is a future slice).

  Cursor-plugin and presence-plugin perf + reconnect wins land transitively; no code changes required in apps that consume the official `cursor(topic)` / `createPresence()` client stores. Apps that render cursor frames directly off the wire need to merge `catalog` (key -> user) with `positions` (key -> data) at draw time - see svelte-adapter-uws 0.5.2 CHANGELOG.

## [0.5.7] - 2026-05-22

### Fixed

- **Double-relay regression introduced by 0.5.6 - consolidated to a single publish-wrap site.** The 0.5.6 fix landed two `bus.wrap(...)` sites that stacked on top of each other under the standard wiring. On the RPC path, `_autoBusWrap` in `message` / `createMessage` wrapped the raw adapter platform with `bus.wrap(rawPlatform)` (outer scheduleRelay); when `_activateDerived(platform)` had also been called - which `realtime().init` always does - the raw platform's `publish` was the mutated `derivedPublish`, whose inner `_refreshBusCache` wrapped a surrogate with `bus.wrap(surrogate)` (inner scheduleRelay). Every `ctx.publish` from an RPC handler thus reached other replicas twice, and receiving replicas' `derivedPublish` fired reactive watchers twice per logical publish. Reproduced via `svelte-realtime-demo`'s `/demos/effect` on a 2-replica deploy: 5 `placeOrder` RPCs via the Burst (5) button fired the leader's `live.effect` ten times instead of five (`orders=5, audit=10, notif=10`), or ten times only when the user's WS landed on the non-leader replica (where the outer wrap was the relay path that reached the leader, and the leader's inner wrap fired the effect on receive + re-relayed). The same shape existed on the cron tick path: `_cronBus.wrap(_cronPlatform)` at every fire stacked on top of `derivedPublish`'s inner wrap.

  The `_BUS_WRAPPED` sentinel that 0.5.6 introduced was meant to catch this but checked the wrong side of the wrap. The sentinel was set on the OUTPUT of `bus.wrap` (the wrapped platform) but the guard ran on the INPUT to `_autoBusWrap` (the raw adapter platform), which never carried the sentinel under the standard wiring. The guard only ever fired for users who manually pre-applied the framework's own `bus.wrap` upstream (which nobody actually does).

  Fix: collapse to **one** `bus.wrap(...)` site in the whole framework. `_wrapPlatformPublish` is now the sole publish-wrap; `_autoBusWrap`, `_rpcBusWrapCache`, the `_BUS_WRAPPED` sentinel, and the cron-tick outer wrap are all deleted. A new internal `_ensureWrap(platform)` helper (idempotent via the existing `_activatedPlatforms` WeakSet) installs the wrap from any seam that captures or first sees a platform reference:
  - `setCronPlatform(platform)` installs immediately - covers pure-cron deployments that never call `_activateDerived`.
  - `_activateDerived(platform)` installs immediately - the previous "no reactive primitives -> skip wrap" gate is removed because the wrap is now also responsible for bus routing, not just watcher fan-out. Per-publish overhead in apps with no bus AND no reactive primitives is one function call plus a `Map.has` check on an empty `Map` (`O(1)`, branch-predicted to false) - well below noise.
  - `message` / `createMessage` returned hook installs on first invocation per platform - covers apps that wire only `setBus(bus)` and re-export `message` (no `init` hook, no `_activateDerived` call).

  Every wiring shape lands on exactly one relay per logical publish, by construction (only one site calls `bus.wrap`, so nothing can stack):
  - **`realtime({ bus, leader })` user**: `init` routes both `setCronPlatform` and `_activateDerived` through `_ensureWrap`, idempotent.
  - **Pure-RPC user with `setBus(bus)` + default `message`**: first message installs the wrap; ctx.publish single-relays.
  - **Pure-cron user with `setCronPlatform(platform)` + `configureCron({ leader, bus })`**: `setCronPlatform` installs the wrap directly.

  Inbound bus delivery is loop-safe: the extensions' `redis/pubsub` bus already passes `{ relay: false }` on inbound `activePlatform.publish` calls (see [pubsub.js:348](node_modules/svelte-adapter-uws-extensions/redis/pubsub.js#L348)), and `derivedPublish` propagates the option through to the inner `bus.wrap` output, which respects the flag and skips the re-relay (see [pubsub.js:186](node_modules/svelte-adapter-uws-extensions/redis/pubsub.js#L186)). Reactive watchers still fire on inbound (cluster-relayed messages reach `live.effect` / `live.derived` / `live.aggregate` on receiving replicas) because the surrogate's `publish` IS `derivedPublishLocal` (originalPublish + fireWatchers, no relay).

  Manual-callback migration: users with a pre-0.5.6 `createMessage({ platform: (p) => bus.wrap(p) })` callback still double-relay because the framework can't detect their wrap (user-built outputs don't carry our sentinel). Dev-mode emits a one-shot warning at receive time when a `platform` callback is used against a process-wide bus, pointing at the migration: drop the `platform` option. Production builds emit no warning regardless. Users with a non-bus `platform` callback (e.g. metrics instrumentation) can ignore the warning - the warning text explicitly covers the false-positive case.

  14 regression tests in `test/server.test.js` cover the invariant from every angle: (a) the demo's exact scenario - `realtime({ bus, leader })` + RPC `ctx.publish` = exactly 1 relay; (b) `realtime` + cron tick = exactly 1 relay; (c) RPC -> `live.effect` -> downstream publishes = exactly 1 relay per topic; (d) pure-RPC path (no `_activateDerived`) single-relays via the message hook's `_ensureWrap`; (e) pure-cron path single-relays via `setCronPlatform`'s `_ensureWrap`; (f) one-shot dev warn for legacy `platform: callback` callbacks; (g) false-positive on `platform: (p) => p` no-op callbacks; (h) first call to `message` installs the wrap (proves `_ensureWrap` covers pure-RPC); (i) first call to `setCronPlatform` installs the wrap (proves `_ensureWrap` covers pure-cron); (j) late reactive registration during an in-flight RPC does NOT cause a double-relay window (closes the narrow race documented during the 0.5.7-pre audit); (k) 100 RPCs on a hot loop = exactly 100 relays (no fan-out drift under volume); (l) `setBus(null)` drops cluster relay overhead to zero (memory sanity); (m) inbound delivery with `{ relay: false }` does NOT re-relay (cluster loop prevention); (n) inbound delivery DOES fire reactive watchers on the receiving replica (cluster reactive correctness).

  Test fixture migration: `test/fixture/src/hooks.ws.js` (the e2e + chaos suite fixture) is updated to use `setBus(bus)` instead of the pre-0.5.6 per-message `bus.wrap(ctx.platform)` callback. The chaos suite's `bus.activate(ctx.platform)` call in `open` is preserved - it registers this instance's inbound Redis subscriber, and the single-wrap design + bus's existing `{ relay: false }` discipline on inbound makes this combination safe end-to-end. Memory: the refactor REMOVES the `_rpcBusWrapCache` WeakMap and the `_BUS_WRAPPED` sentinel entirely, so the post-fix memory profile is smaller than 0.5.6 (one fewer per-platform WeakMap entry, no per-RPC sentinel-write per wrapped output).

## [0.5.6] - 2026-05-22

### Added

- **`realtime(config?)` factory + process-wide cluster bus (`setBus` / `getBus`) + composed-platform accessors (`getPlatform` / `publish`).** One declaration of cluster intent now reaches every framework publish surface in lockstep. `realtime({ bus, leader })` returns the standard adapter hook set (`open`, `close`, `message`, `init`, optional `upgrade`) and wires `setBus`, `configureCron({ leader })`, `setCronPlatform`, and `_activateDerived` for you when the adapter's `init({ platform })` hook fires. Single-replica is `realtime()` with no config; cluster is `realtime({ bus, leader })` with the same handler-level code on both sides. Layered API: Layer 1 (the existing primitives - `setCronPlatform`, `_activateDerived`, `configureCron`, `pushHooks`, `createMessage`) remains the first-class expert surface with no deprecation; Layer 2 (`realtime()`) is sugar over those primitives for the typical case. `setBus(bus)` and `configureCron({ bus })` write the same backing state so apps mixing the two never end up with a split-brain config. `publish(topic, event, data)` is a top-level helper that routes through the composed platform - use it from a `+server.js` HTTP handler or any non-WS context to get the same cluster semantics as a publish inside an RPC / cron / effect handler. Eleven new regression tests in `test/server.test.js` cover the factory shape, end-to-end bus relay through effect handlers, single-replica fallthrough, RPC auto-wrap, idempotence with the manual `createMessage({ platform })` callback, bus-swap mid-process, and the `onError` config option.

### Fixed

- **`live.effect`, `live.derived`, `live.aggregate`, and `live.webhook` handler publishes now relay through the cluster bus when one is configured, fixing silent multi-replica data loss.** Pre-fix, the reactive seam captured the raw adapter platform inside `_wrapPlatformPublish` at activation time; the wrap installed `derivedPublish = originalPublish + fireWatchers` with no bus indirection. Cron and RPC seams DID get bus-wrapped (cron via `_cronBus.wrap(_cronPlatform)` per tick, RPC via the user's `createMessage({ platform: (p) => bus.wrap(p) })` callback in `hooks.ws.js`), so a leader-gated effect on replica A that did `platform.publish('audit', ...)` and `platform.publish('notifications', ...)` from inside the handler delivered to A's local subscribers only - the ~50% of users whose WS landed on replica B never saw audit / notifications. The asymmetry was invisible until the second replica spun up. Surfaced on `svelte-realtime-demo`'s `/demos/effect` page on a 2-replica deploy: clicking "Burst (5)" placed 5 orders, the leader's effect fired correctly, but audit / notifications reached the right user only ~50% of the time depending on which replica was holding their WS. Root cause: the reactive seam was the only framework publish surface that did not consult a bus.

  Fix: switched the reactive wrap to **compose-at-publish-time**. `_wrapPlatformPublish` now keeps the existing local-only fast path AND maintains a memoized `bus.wrap(surrogate)` cache whose `surrogate.publish` is a "local + fire-watchers, no relay" inner publish (`derivedPublishLocal`). `derivedPublish` (the mutated `platform.publish`) consults `_getBus()` at publish time and routes through the wrapped surrogate when a bus is configured; without a bus it falls through to the legacy local path with zero overhead. The same pattern applies to `derivedPublishBatched`. The surrogate's `publish` is `derivedPublishLocal` rather than `derivedPublish` so that inbound bus relays from other replicas fire reactive watchers on the receiving instance WITHOUT bouncing back out onto the bus (preventing the "every replica re-relays every event" loop). Bus-wrap composition is keyed on a monotonic `_busEpoch` counter that bumps on every `setBus(...)` call, so a runtime bus swap re-wraps cleanly on the next publish.

  Existing apps wired the pre-0.5.6 way (`setCronPlatform` + `configureCron({ leader, bus })` + `createMessage({ platform: (p) => bus.wrap(p) })`) pick up the reactive-seam fix for free - `configureCron({ bus })` now also writes the process-wide `_bus` so the reactive wrap consults the same bus. RPC `message` / `createMessage` (when called without a `platform` callback) now auto-wrap via `_autoBusWrap`, so apps that drop the manual `platform: (p) => bus.wrap(p)` get equivalent behaviour with one fewer line; apps that keep the callback are unchanged (the auto-wrap path is bypassed when a user transform is present, so no double-wrap can occur). `bus.wrap` outputs are tagged with `Symbol.for('svelte-realtime.busWrapped')` storing the bus identity, so the auto-wrap is idempotent against a platform that was already wrapped against the same bus.

  README "Redis multi-instance" section rewritten to lead with `realtime({ bus, leader })`; the manual-primitive Layer 1 pattern is preserved as a "for experts" subsection. New "Cluster wiring" rows in the Server API reference table. No demos need to change beyond optional cleanup of the now-redundant `createMessage({ platform })` callback.

## [0.5.5] - 2026-05-21

### Added

- **`configure({ resumeGraceMs })` on the client + resume-grace by default for every stream.** When the last subscriber of a stream unsubs, the stream now releases its WebSocket subscription immediately (releases the server slot, decrements quiescence) but keeps its in-memory data model -- `currentValue`, `_lastSeq`, `_lastVersion`, `_cursor`, `_hasMore`, `_schemaVersion`, history -- for `resumeGraceMs` (default `60000`). A new `subscribe()` inside the window re-attaches the lifecycle listeners and calls `fetchAndSubscribe()` with the retained cursors on the resume envelope, so the server fills the gap from its bounded replay buffer (or `delta.fromSeq`, or a truncated -> full rehydrate fallback) instead of cold-rehydrating. After the grace expires with no new subscriber, the data model is reset and the next subscribe is a true cold start. Set `resumeGraceMs: 0` to opt out and revert to pre-grace immediate-reset behavior; raise it to retain across longer navigation gaps. The grace only governs local retention; the server's replay-buffer and `delta.fromSeq` windows are independent.

### Fixed

- **Pause/resume on a stream-backed UI (e.g. `{#if active} <Sub /> {/if}` toggles, `$effect`-driven subscribe/unsubscribe, browser back-and-forward) now engages the gap-fill chain instead of cold-rehydrating.** Pre-fix (0.5.1 through 0.5.4), the deferred-cleanup microtask reset `_lastSeq` / `_lastVersion` / `_cursor` alongside `currentValue` (0.5.1 added this to fix a separate unmount/remount spinner-hang where a stale seq + reset currentValue + empty since-seq delta left `{#if $store === undefined}` spinners hanging forever). The 0.5.1 fix was correct for the back/forward spinner-hang but it killed the path that pause/resume UIs relied on: every resume sent no seq, the server treated it as a fresh subscribe, the loader ran, the recent window came back tagged `rehydrate`, and any rows the page had already shown got re-tagged via the by-id merge. Reproducer: `svelte-realtime-demo`'s `/demos/from-seq` page, Pause for 5-10s, Resume; pre-fix the rehydrate banner reappears, post-fix the events the server published during the pause stream in tagged `live`. The new resume-grace fixes both: state AND cursors are retained together for `resumeGraceMs`, so the server's delta merges into populated state (no spinner-hang, no false cold-start). The pre-0.5.1 back/forward bug stays fixed -- past the grace window the next subscribe is a true cold start with no stale seq.

## [0.5.4] - 2026-05-17

### Fixed

- **Dev-mode publish-rate sampler no longer pins platform references in Node's timer queue (CRITICAL leak).** Pre-fix, `_activatePublishRateWarning(platform)` armed a `setInterval` whose callback closure strongly captured `platform`, and tracked every activated platform in a strong-reference `Set` (`_publishRateActivePlatforms`). Node's timer queue holds Timer objects alive until `clearInterval` fires; while the timer was alive, the callback was reachable, the captured `platform` was reachable, and the `Set` independently retained it as well. The `_publishRateSamplers` WeakMap above it was rendered useless by both retention paths. Any call pattern that minted a fresh platform per invocation - notably the framework's own cron tick wrapping `_cronPlatform` with `_cronBus.wrap(_cronPlatform)` on every fire - leaked one platform-plus-helpers graph per invocation indefinitely. At ~7 Hz across typical cron workloads the heap grew by ~100 MB/hour. Surfaced on a deployed demo (`svelte-realtime-demo` admission panel) where `NODE_ENV` was inadvertently unset in the container env, opening the `_IS_DEV` gate in production; root cause was the framework retention path, not the env-var miss. Fix: (1) the sampler callback now holds `platform` via `WeakRef`, derefs on each fire, and `clearInterval`s itself on null-deref (platform was GC'd elsewhere); (2) removed `_publishRateActivePlatforms` entirely; (3) added a per-process `_publishRateEpoch` that `_resetPublishRateWarning` and `live.publishRateWarning(false)` bump - samplers self-clear on the next fire when their captured epoch no longer matches. Net behavioural change: disable / reset takes effect within one `intervalMs` (default 5s) instead of synchronously, but no test in this repo relied on synchronous teardown. WeakMap entries clear naturally as the platform becomes GC-eligible.

- **`server.d.ts` now declares `MAX_PRESENCE_REF` and `MAX_PUSH_REGISTRY` alongside the existing `MAX_AGGREGATE_BUCKETS` declaration.** All three are runtime-exported from `server.js` and documented as importable tunables in README's "Capacity caps" section, but only `MAX_AGGREGATE_BUCKETS` had a matching `.d.ts` entry. TS consumers attempting the documented `import { MAX_PRESENCE_REF, MAX_PUSH_REGISTRY } from 'svelte-realtime/server'` hit a typecheck error even though the import works at runtime. Pure typing fix; no runtime behaviour change.

- **`_respond()` dev-warning text and thresholds re-tuned for the post-0.5 `maxPayloadLength` default.** The warning fired by `_respond()` in `_IS_DEV` for large RPC responses still said "may exceed maxPayloadLength (16KB)" and tripped at array length > 100 or string length > 12,000 - both tuned for the pre-0.5 16 KB cap. Under the 1 MB default the literal number was misleading AND the thresholds fired for ordinary list views (200-item dropdown, paginated page, markdown post body) where the actual response was nowhere near the cap. Reworded message to "may exceed maxPayloadLength (default 1 MB; raise `websocket.maxPayloadLength` in svelte.config.js if needed)" and raised thresholds proportionally to the new 64x-larger cap: array `> 5000` items (was `> 100`) and string `> 800_000` chars (was `> 12_000`). At a typical ~200 B/item, 5000 items is roughly 1 MB; at 800K chars the string is roughly 800 KB. Dev-only behaviour; no production-path change.

## [0.5.3] - 2026-05-17

### Fixed

- **`live.room({ presence })` now uses a cluster-shared Redis HASH for the per-room roster when `platform.redis` (a raw ioredis-shaped client with `hincrby` / `hset` / `hdel` / `hgetall` / `expire`) is wired by the host app.** Pre-fix, the per-room presence ref was an in-process `_presenceRef` Map. Cluster `join` / `leave` events DID fan out via `bus.wrap`, so existing subscribers on every replica saw the live transitions, but the loader returned local entries only - a new subscriber on a replica that had no prior joiners got an empty initial list and any users who joined before its loader ran were invisible until they re-joined. Visible in any multi-replica deploy as "Online" lists that show different users in different browsers and re-shrink to "1 online" (self only) on F5 from a replica with no other connected subscribers. The fix introduces three internal helpers (`_clusterPresenceAcquire` / `_clusterPresenceRelease` / `_clusterPresenceList`) backed by a single per-topic HASH (`__live-presence:{topic}`) with two field shapes per user: `c:{userKey}` for the cluster-wide refcount (atomic `HINCRBY`) and `d:{userKey}` for the JSON-encoded presence data. Cluster transition semantics: only the first replica to take a user's count from 0 to 1 publishes `join`; only the last replica to take a user's count from 1 to 0 publishes `leave`. Per-replica per-user tab refcount and the 5-second grace timer stay in the existing local `_presenceRef` Map; the cluster helpers only fire at local 0<->1 transitions, so a rapid reconnect burst on a single replica still doesn't churn the cluster counter. Loader reads `HGETALL` and reconstructs the `{key, data}` shape the merge:'presence' merge type expects. Without `platform.redis` the helpers fall through to the existing local `_presenceRef` iteration, preserving the zero-config dev path unchanged. Subtle race-safety detail: the acquire writes the `d:` data field BEFORE bumping the `c:` count, so a concurrent loader call (e.g. the same user's own `:presence` stream loader racing the data stream's acquire) cannot observe a count without a data field and return an empty roster - the user's own entry is visible from the loader as soon as the count is visible. The previous warning text "wire `platform.presence` (e.g. svelte-adapter-uws-extensions/presence)" is updated to "wire `platform.redis` (raw ioredis client)" to point at the new convention.

## [0.5.2] - 2026-05-17

### Fixed

- **`live.webhook(...).handle()` now `await`s `config.verify` and `config.transform`.** Pre-fix, both were called synchronously, so an async `verify` (e.g. one that consults a Redis-backed shared-secret store) or an async `transform` (e.g. one that RPUSHes the incoming payload into a cluster-shared list before publishing) returned a Promise that the framework treated as a synchronous result. The subsequent `req.platform.publish(topic, mapped.event, mapped.data)` then read `mapped.event` / `mapped.data` from a Promise (undefined for both), which crashed the adapter's wire-envelope builder in `esc(undefined)`. The original sync-only contract was undocumented and unenforced - any author whose verify or transform happened to call `await` would silently break webhook delivery without any framework-side error. The fix adds `await` to both call sites; sync handlers keep working unchanged because `await` on a non-Promise value resolves to the value itself.

- **Client `mutate()` defaults `_serverValue` to `[]` when `currentValue` is undefined and the merge type expects an array (`crud` / `presence` / `cursor` / `latest`).** Pre-fix, an optimistic mutate fired before the stream's loader had resolved (e.g. on a fast-clicking user, or a loader with a real-Redis round-trip that takes a few ms) captured `_serverValue = currentValue = undefined`. `_replayQueue()`'s `_applyChange(undefined, ...)` then ran the page's optimistic change function with `current = undefined`; idiomatic optimistic changes like `(current) => [...current, item]` throw synchronously on `[...undefined]`. The mutate rejected before the RPC was ever sent, the optimistic UI never appeared, and `tryMutate` style error toasts flashed-and-disappeared faster than test timeouts. The fix treats undefined as an empty array baseline for array-merge types, so the optimistic change has something sensible to spread. The eventual loader response replaces `currentValue` cleanly via the response path, and any still-in-flight optimistic entry replays against the new `_serverValue` when the server's confirming event arrives. Non-array merges (`set`) keep their original behaviour (`_serverValue = undefined`); the page's change function for a set-merge stream gets `current === undefined` and is already expected to handle it.

## [0.5.1] - 2026-05-16

### Fixed

- **Client stream `cleanup()` now resets session-resume cursors (`_lastSeq`, `_lastVersion`, `_schemaVersion`, `_cursor`, `_hasMore`, `_loadingMore`) alongside `currentValue`.** Pre-fix, when a dynamic-topic stream's last subscriber unsubscribed (e.g. a SvelteKit page unmounted), the deferred-cleanup microtask reset `currentValue = undefined` and `store.set(undefined)` but left the resume cursors set to their prior-session values. On the next mount (e.g. browser back / forward to the same page) the cached store's first subscribe sent the stale `seq` to the server, the server's `_executeStreamRpc` treated it as a session-resume, ran `platform.replay.since(topic, clientSeq)` which legitimately returned an empty array (no events occurred between unmount and remount on a quiet topic), and responded `{ data: [], replay: true, seq: currentSeq }`. The client's replay branch then looped over the empty array (zero `_applyMerge` calls) and called `store.set(currentValue)` -- but `currentValue` was still `undefined` from cleanup. Any `{#if $store === undefined}` spinner hung forever. Even when events DID occur during the unmount window (replay returned non-empty), the result was wrong: the user got only the delta since their last seen seq, not the full snapshot they expected on remount. The fix resets all session-resume state inside `cleanup()` so the next subscribe is genuinely fresh. In-session WS reconnects do NOT go through `cleanup()` (the reconnect path at the `status === 'open'` handler keeps `_lastSeq` so the replay-buffer gap-fill works for sleep/wake and transient drops), so the optimization is preserved for the cases it was designed for. Reproducer: open a board page with `{ replay: true }` streams, browser-back, click the same board link -- pre-fix hangs on spinner forever, post-fix loads cleanly.

## [0.5.0-next.22] - 2026-05-16

### Added

- **`handleRpc()` rejects RPC envelopes whose parsed JSON exceeds a configurable nesting depth.** Pre-fix, an envelope's depth was bounded only by the adapter's `maxPayloadLength` (default 1 MB). A pathologically nested envelope that fit under the byte cap (a few MB of `{"w":{"w":...}}` nests fine) was passed to downstream RPC handlers and to any host-app instrumentation that recursively walks the parsed object - both potential stack-overflow paths. The new `maxEnvelopeDepth` option (default 64, well past any realistic application shape) caps the post-parse depth via an iterative stack-based walk that short-circuits on the first over-depth descendant. Envelopes past the cap are dropped at ingress (the same path as malformed JSON). The check is itself stack-safe so a 100k-deep envelope cannot blow up the depth-checker. Configurable per `handleRpc()` call; rejection is silent (the message was never a valid RPC) - same shape as the existing malformed-JSON path. 5 new regression tests in `test/server.test.js` cover shallow-accept, default-cap rejection, custom cap (lower + higher), and stack-safety on 5000-level-deep input.

- **`live.public(fn)` wrapper + `// realtime-allow-public` source comment + build-time "no _guard" warning.** The default-allow framework posture (any authenticated WS can invoke any registered handler) is the right starting point for "Hello, world" - it matches every other web framework. But quiet defaults are a foot-gun for apps that forget to add an auth gate to a non-trivial module. The vite codegen now emits a soft `console.warn` at build / dev time when a module exports any `live()` / `live.stream()` / `live.cron()` / etc. handlers but has no `_guard` export. The warning names the three opt-out paths: add a `_guard = guard(...)` export, wrap individual handlers in `live.public(fn)`, or add a `// realtime-allow-public` (or `/* realtime-allow-public */`) source comment. `live.public(fn)` is a runtime no-op (returns the handler unchanged) whose only job is intent: this RPC is intentionally public, don't warn. The comment is a lighter module-wide alternative. Runtime semantics are unchanged - the warning is a build-time nudge, not a hard error. 8 new regression tests in `test/vite.test.js` covering warn / suppress-via-guard / suppress-via-public / suppress-via-comment / suppress-via-block-comment / stream-only / verbose-warning-content / mixed-with-public.

### Changed

- **README: new `### Trust model: target.userId is whatever the caller passes` subsection inside `## Server-initiated push` + a one-line forward callout at the section top.** Pre-fix, the `live.push` / `live.notify` docs explained the API shape and the lookup order but never named in one place that the `userId` argument is identity-blind - the framework delivers to whoever is registered under whatever string the caller passes, full stop. The failure mode (a `live.notify({ userId: msg.to }, ...)` handler with a wire-supplied `to`) is the kind of bug that ships unnoticed because the code "looks right." The new subsection names the trust contract (server-trust primitive, caller decides), gives a wrong-way example (DM handler with `msg.to`) and a generic `mustOwnUser(ctx, targetUserId)` helper that names the four common ownership patterns (self-targeted, admin override, tenant peer, otherwise forbid), and enumerates safe vs. unsafe sources of a `userId` value (server-authored DB rows / `ctx.user.id` / verified webhook claims = safe; any wire field without an ownership check = unsafe). Forward-compatible: same contract applies to any future push-target shape (`{ group, role, tenant }`). No code change; docs only.

- **Scaffolded `hooks.ws.ts` from `npx svelte-realtime` now emits a runtime `console.warn` on every accepted connection until the developer deletes the `SCAFFOLD_PLACEHOLDER` marker.** Pre-fix, the scaffolded `upgrade()` returned `{ id: crypto.randomUUID() }` and the only nudge to replace it was a block comment at the top of the file - the kind of thing that decays into invisibility as the developer's eyes glaze over the header to scroll to the function body. Apps that scaffolded, built, and deployed without replacing the hook had no real identity guarantee (every connection got a fresh UUID); the comment-only deterrent provided no runtime signal. The fix keeps the permissive default so the first `npm run dev` works without identity wiring (zero-config "Hello, world" path stays intact), but adds a `const SCAFFOLD_PLACEHOLDER = true;` line whose presence triggers a `console.warn` on every connection: dev terminals get a per-connection nudge, prod log aggregators get unmissable noise until the developer deletes the single marker line. Deletion is the explicit "I have replaced this with real auth" action - it requires a code change, not a comment edit, so it cannot be skipped by accident. The block comment header is also rewritten to name the three real auth patterns (cookie-validated session, JWT/bearer token, signed query token) with concrete `req.getHeader(...)` snippets so the developer has something to copy rather than a vague "replace this!". Both `--template minimal` and `--template example` ship the same hook (the `--template demo` path is unaffected; it clones the external demo repo). `+4 new test cases` in `test/cli.test.js` pin: the three auth patterns are listed by name; the SCAFFOLD_PLACEHOLDER marker is present; the runtime `console.warn` references the file path so the developer can jump straight to it; both templates write the same hook (a regression to per-template hook content would fail this check).

- **`Math.random()` call sites marked as not security-relevant.** Three call sites (`client.js` `_idPrefix` for cross-tab RPC correlation IDs, `client.js` reconnect-jitter pair at attempt-counter < 2 and exponential-backoff branches, `test.js` chaos drop-rate check) all use `Math.random()` for collision avoidance or jitter - none produce auth tokens, session IDs, or values that cross a trust boundary. Comments-only change adding an explicit "not security-relevant" marker at each site so a future contributor reading the code does not "fix" it by swapping in `crypto.randomUUID()` (which would be wasted entropy plus the wrong API for jitter math). No runtime change.

- **CLI `run()` helper builds the child env via `delete env.NODE_ENV` rather than `{ ...process.env, NODE_ENV: undefined }`.** Both forms produce the same child-process env on Node >=22 (Node drops keys whose value is `undefined` from the env it hands to the OS exec call; the child sees `'NODE_ENV' in process.env === false`, not `process.env.NODE_ENV === 'undefined'`). The historical concern that `undefined` serializes to the literal string `'undefined'` does not reproduce in current Node - the historical bug, if it ever existed in production, was patched in an older Node release. The change is therefore semantics-clarity only: `delete env.NODE_ENV` is the unambiguous form that does not depend on Node-internal handling of `undefined` values, so the next reader does not have to look up which Node version started dropping `undefined` env values. No behavior change for any current user.

- **Stream RPC subscribe now routes through `platform.subscribe(ws, topic)` instead of `platform.checkSubscribe` + raw `ws.subscribe`.** Pre-fix, `_executeStreamRpc` called the adapter's `checkSubscribe` (gate-only) and then raw `ws.subscribe(topic)` to perform the actual subscription, which bypassed the adapter's per-connection subscription bookkeeping: `MAX_SUBSCRIPTIONS_PER_CONNECTION` was not enforced for stream-RPC subscribes, the per-connection `subs` Set was not updated, the `totalSubscriptions` counter was not bumped, and the close-hook's `ctx.subscriptions` parameter was missing every stream-RPC topic. Apps that walk `ctx.subscriptions` in a close hook (for per-topic cleanup, audit, billing) saw an incomplete set. The fix replaces the gate + raw subscribe pair with a single `platform.subscribe(ws, topic)` call which runs the same hook chain atomically, enforces the cap, and updates adapter-side state. The optional-chain on `platform.subscribe` keeps older adapters working: if the method isn't there, we fall back to raw `ws.subscribe` and only the in-realtime gates (`__streamFilter`, `live.room({ guard })`) remain the stream-RPC access checks. Test platform mock (`test.js` `createTestEnv()` and `test/helpers/mock-platform.js`) gains a default `platform.subscribe` that delegates to `ws.subscribe` and consults `p.checkSubscribe` if set, so existing denial-injection tests using `p.checkSubscribe = ...` keep working without changes. Two new regression tests in `test/server.test.js` pin: (a) the stream RPC calls `platform.subscribe` (not raw `ws.subscribe`) so the adapter sees the subscription; (b) a `platform.subscribe`-returned denial blocks the loader, suppresses the `__onSubscribe` 'join' broadcast, and surfaces the denial code on the RPC response.

### Fixed

- **`ctx.signal(userId, ...)`, `pushHooks.open(ws, ...)`, and `enableSignals(ws, ...)` now validate the `userId` before interpolating it into a system-topic name (`__signal:${userId}`).** Pre-fix, callers could pass arbitrary strings including CR / LF / NUL / quotes / backslash / oversized values, which would corrupt log lines, escape the `__signal:` namespace, or land in the adapter's topic name as a malformed byte sequence. M-INT-TOPIC (shipped earlier) blocks user code from publishing to `__`-prefixed topics via `ctx.publish`, but the three server-side builders that LEGITIMATELY publish/subscribe to `__signal:*` were exempt and consumed their `userId` arg unchecked. The fix adds a shared `_validUserIdReason(userId)` validator (rejects: non-string, empty, > 256 chars, control bytes 0x00-0x1F, DEL 0x7F, `"`, `\`) used at all three sites. `ctx.signal` throws `LiveError('INVALID_USER_ID', ...)` on bad input (mirrors `ctx.publish`'s `LiveError('INVALID_TOPIC', ...)`). `pushHooks.open` throws a plain Error (mirrors its existing non-string-throw behavior) but still silently skips null / empty / undefined for the anonymous-connection pattern. `enableSignals` also throws on bad input but still silently skips null / undefined. Non-ASCII bytes are accepted at all three sites for parity with the adapter's `allowNonAsciiTopics` opt-in. `+9 new test cases` covering all three sites x several invalid shapes x clean-userId-accept x anonymous-skip behaviors.

### Security

- **CRUD / presence / cursor merges now strip `__proto__` / `constructor` / `prototype` from envelope data at ingress.** Pre-fix, `_applyMergeFn` (client) and `_applyTestMerge` (test) stored user-supplied envelopes verbatim in reactive arrays without filtering own-property keys that mutate `Object.prototype` via downstream `Object.assign`. The framework itself never spreads stored items (the live exploit surface today is zero), so this is defense-in-depth: a future refactor that introduces `Object.assign({}, item)` or a host-app `for..in` over the array can no longer be made to pollute `Object.prototype` by an attacker landing a row with `JSON.parse('{"__proto__":{"polluted":1}}')` semantics.

  Fix: promoted the existing inline `_safeAssignSnapshot` helper (used by `live.aggregate` snapshot hydration) into a shared module at [shared/safe-assign.js](svelte-realtime/shared/safe-assign.js). The new module exports `safeAssign(dst, src)` (the original behavior), `sanitizeRowData(data)` (returns the input unchanged when no danger keys are present - zero allocation on the hot path - or a sanitized shallow clone with the danger keys stripped), `assertSafeMergeKey(keyValue)`, and the frozen `PROTO_POLLUTION_KEYS` list. The CRUD / presence / cursor branches of `_applyMergeFn` and `_applyTestMerge` now pass `envelope.data` through `sanitizeRowData` before storing or indexing. Arrays are processed element-by-element so the `refreshed` event (which replaces the whole array) cleans each row too. `set` and `latest` merges intentionally skip sanitization to preserve reference identity for callers who depend on `value === data` after a snapshot.

  Performance: 3 x `hasOwnProperty` checks per envelope when the data is danger-key-free (the universal case); zero allocation. One shallow clone when at least one danger key is present (extremely rare in legitimate traffic). The cost is unmeasurable against the surrounding merge-and-broadcast work.

  Apps see no behavior change for any legitimate envelope; the only observable difference is that an attacker-crafted envelope no longer lands in the store as-is. 20 regression tests in `test/safe-assign.test.js` cover the new helper, including an end-to-end PoC that confirms `Object.prototype` is not polluted after the sanitizer + a downstream `Object.assign`.

- **CLI `run()` helper migrated from `execSync` with template-string commands to `execFileSync` with explicit arg arrays.** Pre-fix, every `run()` invocation in `cli.js` assembled a shell-tokenized command string from interpolated variables (`\`git clone ${DEMO_REPO} "${name}"\``, `\`${agent} ${add} svelte-adapter-uws svelte-realtime\``, etc.). The `name` placeholder was already gated by `cli-utils.VALID_NAME_RE` (`/^[a-zA-Z0-9_-]+$/`) and the `agent` placeholder is a 4-value enum from `detectAgent`, so no exploit existed at any current call site - but the shape was fragile: a future contributor adding an unvalidated interpolated arg would reintroduce shell injection at the system-call boundary. The fix flips every call site to `run(file, [...args], cwd?)` so args reach the OS exec call without shell tokenization. Five call sites updated: git clone, sv create scaffold, three package-manager add/install commands. A new `bin(name)` helper resolves npm / pnpm / yarn / bun / npx to their `.cmd` shim names on Windows (Node >=22 EINVALs `.cmd` files under `shell: false`, so the run helper sets `shell: process.platform === 'win32'` per-call on that platform; the args are validated upstream so the DEP0190 escaping caveat does not apply here). Native binaries (git) work as-is on every platform. `+5 new test cases` in `test/cli.test.js` pin the contract: cli.js imports `execFileSync` (not `execSync`); no `run()` invocation uses a backtick template-string first argument; git clone, sv create, and the bin() helper match their expected array-shape signatures.

## [0.5.0-next.21] - 2026-05-14

### Changed

- **Auto-replay routing for `live.stream({ replay: true })`: framework owns the wrapping; user-side `wrapWithReplay` proxies are no longer needed.** Pre-fix, the user was responsible for wrapping the platform with a `wrapWithReplay` proxy at every seam (`createMessage({ platform: wrapWithReplay })` AND `setCronPlatform(wrapWithReplay(platform))`). The docs showed the wrap on the RPC seam only; cron-published events to a `replay: true` topic silently bypassed the buffer because the cron platform was captured separately and never went through replay.publish. The documented three-tier reconnect (`replay -> delta.fromSeq -> rehydrate`) was effectively broken end-to-end for cron-fed streams: pause+resume saw the loader rehydrate but never the buffered backfill. The fix moves replay routing into the framework. `live.stream(topic, loader, { replay: true })` registers the topic at declaration time (or at first-subscribe time for dynamic topic factories). When the adapter exposes `platform.replay`, every framework publish surface (`ctx.publish`, cron auto-publish, `ctx.publish` from inside cron handlers) auto-routes through `platform.replay.publish(...)` for registered topics regardless of which seam the publisher sits on. Users opt out of framework auto-routing by marking their proxy with the exported `WRAPPED_FOR_REPLAY` symbol (back-compat escape hatch); without the marker, the framework's auto-routing would run alongside the user's proxy and double-write to Redis. Most `wrapWithReplay` proxies were doing exactly what the framework now does built-in (regex-match topics + route to replay.publish); the framework's registry-from-declaration approach is more precise (sourced from `live.stream({ replay: true })`, not regex patterns) and removes the asymmetry between seams. Dev-mode warns once per topic when `replay: true` is declared but `platform.replay` is missing, with the install pointer for the replay extension. Production runs silently with zero per-publish overhead (one Map.has check on the publish hot path; gated by the per-topic registry which is empty when no streams use replay). Twelve new tests pin: static-topic ctx.publish auto-routing (1); non-eligible topic falls through to platform.publish (1); cron auto-publish to a replay-eligible topic auto-routes (1); cron auto-publish to non-eligible topic uses bare publish (1); dev-warns ONCE per topic on missing platform.replay (1); WRAPPED_FOR_REPLAY marker defers framework routing (1); dynamic-topic stream registers at first-subscribe time (1); publishBatched fast path is bypassed for replay-eligible topics so the extension stamps seq per-call (1); non-eligible topics still use publishBatched fast path (1); sync throw from replay.publish falls back to platform.publish so no event is lost (1); async rejection from replay.publish surfaces as dev warn but does not break the publisher (1); WRAPPED_FOR_REPLAY exported as stable Symbol.for marker (1). See `MIGRATION.md` for the rationale and migration shape; users without a custom `wrapWithReplay` proxy need to do nothing (the silent-bypass bug is fixed for free); users with one need to either drop the proxy or add the `[WRAPPED_FOR_REPLAY] = true` marker.

## [0.5.0-next.20] - 2026-05-14

### Changed

- **`live.upload`: `configure({ upload: { chunkSize } })` renamed to `frameSize`; framework now guarantees no wire frame ever exceeds the adapter's `maxPayloadLength`.** Pre-rename, `chunkSize` was raw payload bytes per chunk, with no clamp and no warn. A user reading "the adapter cap is 1MB" and setting `chunkSize: 1024 * 1024` was correctly following the docs and silently built frames slightly over the cap (envelope overhead added `12 + argsLen` bytes); uWS evaluated frame size on receive and closed the connection with code 1009. The failure was silent: the client error path never fired because the connection close beat the chunk send-ack. The fix shifts the knob's semantic to wire frame size (matching `platform.maxPayloadLength` 1:1), enforces a hard ceiling at the discovered adapter cap (with a one-time dev warn when clamping kicks in), and subtracts envelope overhead per chunk internally (10 bytes on chunks 1+, `12 + argsLen` on chunk 0; `argsLen` is computed once per upload from the actual args, not budgeted statically). `chunkSize` is accepted as a deprecated alias with a one-time dev warn pointing at the rename; existing config keeps working. The auto path drops the old 0.9 safety factor: frame size auto-defaults to the FULL discovered cap, since envelope subtraction is now done correctly. Eight new tests pin: clamp-down with one-time warn (1); does not warn a second time when the same clamp recurs (1); `chunkSize` alias works + emits one-time deprecation warn (1); `frameSize` wins when both fields set + no deprecation warn (1); per-chunk envelope overhead computed correctly (chunk 0 fills `frameSize` exactly, chunks 1+ leave `2 + argsLen` bytes unused) (1); longer args reduce per-chunk payload size (1); cold-start uses 12KB default + frames fit under it (1); post-discovery uses full cap not 90% (1). Six existing tests updated to use the new `frameSize` semantics via a `frameSizeForPayload(path, args, payloadBytes)` helper that computes the right frame value for a target payload size (replaces hard-coded `chunkSize: 4` patterns). See `MIGRATION.md` for the rationale and migration shape; the value passes through unchanged in nearly all cases.

## [0.5.0-next.19] - 2026-05-13

### Security

- **`live.access.any(...)` / `live.access.all(...)` no longer fail open when sub-predicates are async (HIGH).** Pre-fix, both helpers iterated sub-predicates via `Array.prototype.some` / `every`, which read a `Promise<false>` as truthy and either short-circuited to allow (`any`) or fell through to allow (`all`). Apps composing async predicates inside `any` / `all` (`live.access.any(asyncCheck1, asyncCheck2)`) silently bypassed every gate the developer wrote. An earlier runtime fix closed this for the TOP-LEVEL predicate but not for composed sub-predicates inside `any` / `all`; the docs page carried an "open finding" callout warning users away from this composition pattern. The helpers now return `Promise<boolean>` and `await` each sub-predicate in order, preserving the correct short-circuit semantics: `any` returns `true` on the first truthy sub-predicate (sync or async), `all` returns `false` on the first falsy sub-predicate. Sync predicates work transparently because `await` unwraps non-Promise values.

  Type signatures for `live.access.any` and `live.access.all` widened from `(...predicates: Sync) => Sync` to `(...predicates: Sync | Async) => Async`. Runtime impact: callers using these helpers as a stream `access` option are unaffected (the runtime already awaits the top-level predicate). Callers invoking the returned predicate manually must `await` the result. The `live.access.org` / `live.access.user` / `live.access.role` / `live.access.owner` / `live.access.team` leaf helpers are unchanged (still sync) - the change is composition-only.

## [0.5.0-next.18] - 2026-05-10

### Fixed

- **`StreamOptions.filter` / `StreamOptions.access` / `live.gate` predicate return types widened to `boolean | Promise<boolean>`.** Runtime has been awaiting these predicates since the async-safety fix; the type declarations were stuck on sync-only `boolean`. TypeScript users with async predicates either had to assert their return type or risk the strict-mode error. The `live.gate` JSDoc claiming "Synchronous function checked before subscribing" was also stale; updated.

## [0.5.0-next.17] - 2026-05-10

### Changed

- **Bumped `engines.node` to `>=22.0.0` (was `>=20.0.0`).** Tracks `svelte-adapter-uws` 0.5, which pins `uWebSockets.js` v20.67.0 (Node 20 dropped upstream). Node 22 LTS, Node 24 current, and Node 26 supported. Also bumped `devDependencies.svelte-adapter-uws-extensions` from `^0.5.0-next.8` to `^0.5.0-next.9` to match current published version. See `MIGRATION.md` for the runtime-bump checklist.
- **Refreshed `node_modules` and ran `npm audit fix` to bump transitive `picomatch`, `postcss`, and `vite` past their CVE-affected ranges.** No source change; remaining low-severity advisories all trace to `cookie<0.7.0` via `@sveltejs/kit`.

### Security

- **Aggregate snapshot hydration skips `__proto__` and `constructor` (LOW).** Pre-fix, `Object.assign(entry.state, snapshotState)` accepted any keys present in the snapshot payload. A snapshot returned from a backend (Redis cache, JSON payload from another service) is a hostile-input boundary - a payload like `JSON.parse('{"__proto__":{"polluted":1}}')` would have stamped `polluted` on `Object.prototype`, reaching every other object in the process. Fix: snapshot hydration now copies own enumerable keys via a small helper that explicitly skips `__proto__`, `constructor`, and `prototype`. Both the single-snapshot path (`live.aggregate(..., { snapshot })`) and the per-window snapshot path (`live.aggregate(..., { snapshots: { ... } })`) go through the helper.
- **CLI scaffold `hooks.ws.ts` warns about the no-auth default (LOW).** The scaffolded `hooks.ws.ts` exports an `upgrade()` hook that returns `{ id: crypto.randomUUID() }` - there is no authentication. The file now opens with a multi-line SECURITY comment that explains the default, points to the right thing to replace before deploying, and notes that returning `false` rejects the connection. Apps that ship the scaffold to the public internet without replacing the upgrade hook still have no identity guarantee, but the warning lives at the call site rather than in docs that may never get read.

### Security

- **Global middleware `next()` is single-call-guarded; double-`next()` throws (MED).** Pre-fix, a buggy middleware written as `next().then(() => next())` re-entered the chain and executed the downstream handler twice. Side-effecting handlers (charge customer, send email, increment counter) silently doubled their effects on every request that flowed through the buggy middleware. Fix: each middleware frame in `_runWithMiddleware` now creates its own one-shot `next()`. The second call throws `Error('middleware: next() called more than once. Each middleware must call next() at most once...')` with a clear pointer to the bug. The throw lands inside the user's middleware function (typically caught by the surrounding RPC error handler) so the call fails loud rather than silently doubling. Mirrors the safer guard pattern already in `svelte-adapter-uws/plugins/middleware/server.js`.
- **`ctx.publish()` reserves the `__` prefix for framework-internal channels (MED).** Pre-fix, app code could call `ctx.publish('__signal:victim', ...)` or `ctx.publish('__rpc', { id: 'guess', ok: true, data })` to spoof framework-internal frames. Combined with the wire-side `__`-subscribe block, the only legitimate publisher of system channels should be the framework itself via the lower-level `platform.publish(...)`. Fix: `ctx.publish()` now throws `LiveError('INVALID_TOPIC', ...)` when the topic begins with `__`. Apps that genuinely need to broadcast on a `__`-prefixed topic should reach for the unwrapped `platform.publish(...)` directly so the intent is explicit at the call site. Server-side `live.signal()` and the plugin-side broadcasts (`__presence:*`, `__group:*`, `__replay:*`) are unaffected - they go through `platform.publish()`, not `ctx.publish()`.
- **Realtime rate-limit identity probes `id`, `user_id`, and `userId` (MED).** Pre-fix, the default per-handler rate-limit identity key read only `ctx.user.id`. Apps with sessions whose shape uses the Postgres-convention `user_id` or the camelCase `userId` field fell back to the per-connection guest bucket - defeating per-user rate limits exactly when they mattered most. Fix: `_getIdentityKey` now reads `ctx.user.id ?? ctx.user.user_id ?? ctx.user.userId` (mirrors `_defaultPushIdentify`'s probe order). Apps with custom session shapes can still override via `live.rateLimit({ identity: ctx => ... })`.
- **`live.upload({ reauthEvery })` opt-in re-runs the module guard mid-stream (MED).** Pre-fix, `_startUpload` ran the module guard once at chunk-0 arrival; if the user's session was revoked mid-upload (token expiry, explicit logout, role downgrade) the upload kept running with the original auth grant. Fix: passing `live.upload(handler, { reauthEvery: <bytes> })` re-runs the same guard against the live `ctx` every N bytes received past the last re-auth. If the guard rejects, the upload aborts with the error code (`UNAUTHENTICATED` / `FORBIDDEN`) and the consumer observes the abort signal. Default unset (legacy behavior: guard runs once at chunk-0 only); option must be opted into per upload because not every upload has a meaningful re-auth boundary (write-once short uploads do not need it; long-tail user uploads do). Reauth runs as a fire-and-forget async task off the chunk-receive path so the receive loop stays sync; concurrent re-auths on the same upload are coalesced.
- **Vite codegen path interpolation now JSON-quoted (MED).** Pre-fix, the Vite plugin emitted client stubs and server-bundle registrations as `__rpc('${modulePath}/${name}')` and `__register('${rel}/${name}', ...)`. Both `modulePath` and `rel` are derived from a filesystem walk; on platforms that allow `'` in filenames (Linux, macOS, even Windows) a hostile dependency or co-developer's bad rename could embed a single quote in the path, breaking out of the generated string literal. Codex demonstrated a working RCE in the generated server bundle (`__rpc('x'); globalThis.__audit_pwn=1; ('/ping')`). Fix: every `${modulePath}/${name}` and `${rel}/${name}` interpolation in the codegen now routes through `JSON.stringify(...)`, producing double-quoted JS string literals with proper escaping (matches the pattern already used for `import("...")` resolution). 33 codegen sites swept across `_generateClientStubs` (RPC stubs, stream stubs, channel stubs, binary stubs, upload stubs, derived stubs, room sub-streams, aggregate per-window streams) and the registry-bundle generator (`__register`, `__registerGuard`, `__registerCron`, `__registerDerived`, `__registerEffect`, `__registerAggregate`, `__registerRoomActions`, room sub-handler registrations).

### Added

- **`live.upload({ reauthEvery: number })` option.** Re-runs the module guard against the live `ctx` whenever the upload crosses an N-byte threshold past the previous re-auth. Defaults to unset (legacy behavior).

### Security

- **Stream `access` / `filter` predicates and `live.gate` predicates no longer fail open when async (CRITICAL).** Pre-fix, the wire-RPC stream path read `if (!streamFilter(ctx, ...))` and the SSR mirror read `if (!predicate(ctx, ...))` synchronously. An async predicate returns a `Promise`, which is truthy, which made the deny branch unreachable - async-deny became async-allow. Every stream guarded by `access: async (ctx) => ...` (the idiomatic shape for predicates that consult a DB / session store) silently bypassed the developer's intended gate. Fix: `_executeStreamRpc` and `_runDirectCall` now await the predicate before the truthiness check. The matching adapter-side fix (peerDep `^0.5.0-next.20`) makes `subscribe` / `subscribeBatch` async-safe and `platform.checkSubscribe` returns a `Promise<string|null>` - callers in this package now `await` it. Sync predicates and sync `checkSubscribe` returns are unaffected (await unwraps non-Promise values transparently).
- **`live.idempotent` cache key namespaced by RPC path (HIGH).** Pre-fix, the wrapper used the raw client-supplied `idempotencyKey` as the cache slot regardless of which RPC path was registered with it. A caller running `publicRpc.with({ idempotencyKey: 'abc' })` after a privileged `privateRpc.with({ idempotencyKey: 'abc' })` hit the same slot and read the private result without invoking the public handler. Fix: the wrapper now stamps `__idempotencyPath` on itself when registered (mirrors the existing `__rateLimitPath` propagation) and the cache key sent to `store.acquire(...)` is `'rpc:' + path + ':' + userKey`. Custom `keyFrom` callbacks should still encode tenant scope explicitly (the framework cannot guess the app's tenant shape) but the cross-RPC class is now closed at the framework boundary. Cap added: `idempotencyKey` longer than 256 characters now throws `LiveError('INVALID_REQUEST', ...)` - pre-fix, the stores accepted attacker-supplied 200KB keys.
- **Cache-key shape is NOT backward compatible.** In-flight cache entries from before this release become invisible after deploy (the namespaced key does not match the old un-namespaced key). For Redis-backed stores the old keys eventually TTL out; for in-memory stores the entries clear on process restart.

### Security

- **`live.upload` aggregate pre-handler buffer cap (HIGH).** Pre-fix, every concurrent upload stream got its own 16 MB pre-handler-resolution buffer with no aggregate cap. N concurrent connections opening streamId 0 with a 16 MB chunk-0 payload each = 16*N MB worker memory before any handler-side cap could fire. Default cap raised to 64 MB across all in-flight pending uploads; chunk-0 frames that would exceed are rejected with `OVERLOADED` and the streamId is never registered. Bytes are released back to the accumulator as each upload transitions from pending to running phase, so the cap only bounds the pre-handler window. Tunable via `_setCapsForTest({ uploadPendingMaxAggregate: bytes })` for tests; a runtime option is a follow-up.

## [0.5.0-next.16] - 2026-05-09

### Changed

- **Loud-fail upgrade for two silent-fail edges in the wrapper / RPC surface.** Two unrelated paper cuts that both fall in the same shape: the primitive's contract is correct, but the failure mode is silent and surprising, costing every developer 10-20 min of debug the first time they hit it. (1) `live.idempotent` and `live.lock` now reject unknown config fields at registration time with a cross-helper hint specifically calling out the `key` / `keyFrom` divergence (`live.idempotent` uses `keyFrom`; `live.lock` uses `key`, which accepts a string OR a function). Mistakenly mirroring the wrong helper's shape used to silently fall through to the no-key bypass on idempotent (every call ran unguarded, the one-per-key guarantee broke without warning) or to a different validation error on lock (loud, but only for the specific `key`-required case; typos like `maxWait` for `maxWaitMs` were silent there too). The new error message includes the helper name, the unknown field, the allowed fields, and - for the `key` / `keyFrom` case - a one-line cross-helper note that converts the debug into a 2-second eye-scan. (2) The client-side microtask RPC dedup ([client.js:441](client.js#L441)) is correct and load-bearing for accidental double-taps, but `Promise.allSettled(Array.from({ length: 25 }, () => buyProduct('phone')))` collapses to one wire request with all 25 promises resolving to the same response and zero diagnostic. The client now logs a one-time `console.warn` on the first coalesce per RPC path per session, with a one-line pointer to `.fresh(...)` (the documented bypass). Dev-only (stripped under `NODE_ENV=production`); both the bare `__rpc` path and the `rpc.with({ idempotencyKey })` path go through the same warn-once gate; double-tap dedup on the same path warns once, never again. Eleven new tests pin: idempotent + lock unknown-field throws with cross-helper hints (4); dev-warn fires once on first coalesce with path + `.fresh` pointer (1); does not warn a second time on the same path within the session (1); does not warn when args differ / no coalesce happens (1); warns separately per path (1); also fires on the `.with({ idempotencyKey })` branch (1); silent under `NODE_ENV=production` (1); `.fresh()` bypasses dedup AND does not warn (1).

## [0.5.0-next.15] - 2026-05-09

### Added

- **`subscribeAt(stream, { schemaVersion })` for end-to-end schema-migration demos and e2e tests** - new module entry `svelte-realtime/test-client` that exports a single helper for constructing a parallel Svelte store at a chosen client-side `schemaVersion`. The helper walks the same wire path as a real reconnecting stale client: a `subscribe { schemaVersion: N }` envelope goes out, the server's existing `_executeStreamRpc` migration codepath sees `clientSchemaVersion < serverVersion`, runs `_migrateData` forward through the registered chain, and returns the migrated payload, which the parallel store renders. Plumbing change in `client.js`: stream factories now stamp `__streamPath` / `__streamOptions` / `__streamArgs` on the returned store (and `__streamIsDynamic` on dynamic factories) so `subscribeAt` can construct a parallel store from a stream reference without forcing the user to repeat the topic path. Also adds an internal `_createStreamAtSchemaVersion` factory and threads an optional `initialSchemaVersion` 4th param through `_createStream` so the very first subscribe envelope carries the chosen version. Use cases: (1) demo pages rendering "what would a stale v1 client see on reconnect right now?" side-by-side with the production v2/v3 store, all auto-updating on shared topic publishes; (2) Playwright e2e specs asserting that the migrate chain produces the expected current-version-shape from a v1-cached subscribe, walking the real wire path rather than a parallel-plumbing helper. Lives in `/test-client` (not `/client`) so the import path is loud at every call site - a public client-side schema-pin would let production code chain through migrations on every fetch, which is wasteful and confusing; schema migration is fundamentally about long-disconnected clients catching up, not opt-in version pinning. Faithful production semantics: migration is applied ONCE on the initial subscribe response, then subsequent live publishes arrive as raw current-version events and merge into the migrated base, exactly as a real reconnected stale client would experience. Thirteen new tests pin: metadata stamping on static stream / dynamic factory / dynamic cached store; `schemaVersion` carried on the very first subscribe envelope for static and dynamic shapes; `schemaVersion: 0` rides the wire as a real version (not "unset"); parallel store renders a different (migrated) payload than the production store; both stores receive the same publish on the shared topic and update independently; arg validation rejects null / non-stream / bare-writable / missing options / non-integer / negative / non-finite / NaN / Infinity / fractional version inputs.

## [0.5.0-next.14] - 2026-05-08

### Changed

- **`live.push` now rejects with structured `LiveError` codes for every failure mode**, removing the message-substring sniff that callers needed for deadline expiry. Deadline expiry from the adapter primitive (`Error('request timed out')`) and any remote-registry rejection that uses the same wording are translated to `LiveError('TIMEOUT', ...)` - message text is preserved verbatim on `.message` (so existing `err.message.includes('timed out')` callers keep working) and the original error rides on `.cause`. Argument-validation throws (bad target / event / options / `timeoutMs`) lift from plain `Error` to `LiveError('VALIDATION', ...)`; `live.notify`'s validation throws lift to the same code for parity. Other rejection sources are untouched: a recipient-thrown `LiveError` propagates as-is (no double-wrap), `Error('connection closed')` from the adapter passes through, and registry-layer offline rejections keep whatever shape the registry chose. With this slice the full `live.push` failure surface discriminates via `err.code` (`VALIDATION` / `NOT_FOUND` / `TIMEOUT` / caller-defined), matching the rest of the framework's error surface (`UNAUTHENTICATED` / `FORBIDDEN` / `RATE_LIMITED` / `LOCK_TIMEOUT` / etc). Six new tests pin the new contract: TIMEOUT translation on the local adapter path with verbatim message preservation, non-timeout adapter errors (e.g. `'connection closed'`) passing through unchanged, recipient-thrown `LiveError` not double-wrapping, TIMEOUT translation on the remote-registry path, non-timeout remote-registry errors passing through, and recipient-thrown `LiveError` from a remote-registry response not double-wrapping. Existing validation tests upgraded to also assert `code === 'VALIDATION'` (push) / synchronous `LiveError` instance (notify).

## [0.5.0-next.13] - 2026-05-08

### Added

- **End-to-end upload coverage against the production build.** Four new Playwright tests in `test/e2e/uploads.spec.js` exercise `live.upload` against both the Vite dev server AND the built production server (svelte-adapter-uws output via `node build/index.js`), proving the wire format, the chunk pump, the cancel-control-frame routing, and the progress event chain all round-trip cleanly through the bundled `ws-handler.js` path. Tests cover: single-chunk happy path with byte-content verification, multi-chunk with explicit small `chunkSize` (5 sequential frames for a 20-byte payload at 4-byte chunks), `cancel()` mid-upload rejecting with `RpcError('CANCELLED')`, and progress events with strictly-increasing `sent` counts. Total e2e suite is now 28 specs (14 dev + 14 prod), all green. Test fixture adapter bumped to `^0.5.0-next.19` to match this release's peer-dep, picking up the binary `sendQueued` fix without which `live.upload` chunks were silently text-frame-mangled to `'{}'`.

### Fixed

- **Vite plugin: SSR stub generation diverged from client stub classification, breaking pages that subscribe to ctx-only-topic streams during SSR.** The `0.5.0-next.8` plugin upgrade taught the client-side classifier (`_isDynamicExport`) that single-arity ctx-only topic functions like `(ctx) => 'inbox:' + ctx.user.id` are *static* (no client args, secure-by-construction), so the client stub became a `StreamStore` (readable directly) instead of a factory. The SSR stub generator (`_generateSsrStubs`) was missed in that pass and continued to use a coarse arity-blind regex (`DYNAMIC_STREAM_RE`) that tagged ANY function-form first arg as dynamic. Result: client said "static StreamStore", SSR said "factory function", and `$inbox` during SSR rendering called `factory.subscribe(...)` - crashing every affected page with `TypeError: store.subscribe is not a function` and a 500 response. Bisect localized to commit `be2daf3` (next.8); the multi-page-auth e2e suite has been failing on that path for ~5 days, masked locally by Vite's optimised-deps cache. Fix unifies both paths through the canonical `_isDynamicExport` classifier with a single source-of-truth - one classifier, both call sites, no possibility of drift. Two new regression tests pin: SSR stub uses static `readable(undefined)` shape for ctx-only topics matching the client-side `__stream(path, options)` (no trailing `, true`); SSR stub uses factory shape for ctx + client-arg topics matching the client-side `__stream(path, options, true)`. Updates the test fixture's `auth/+page.svelte` to drop the stale `inboxFor()` factory call now that the import is correctly typed as `StreamStore` end-to-end.

- **Vite plugin: server-side `__register` was missing for `live.upload()` exports.** The codegen at `vite.js:1117` emitted client-stub `__upload(path)` lines correctly but never matched the upload pattern in the server-side registry generation block (`vite.js:1877`), so resolved upload paths returned `null` from `_resolveRegistryEntry` - i.e. the server saw the chunk frame, looked up the path, and silently dropped the upload after responding `NOT_FOUND` (or hung when the response routing missed). Bug surfaced only in end-to-end tests against the built production registry; unit tests passed because `__register` was called by hand. Adds the missing detection block alongside the existing binary one. Same module path / lazy loader pattern as live.binary; nothing else to wire.

- **Backpressure-aware paced sending for `live.upload` chunks.** The client pump now checks `conn.bufferedAmount` (svelte-adapter-uws/client `0.5.0-next.19+`) after every chunk and pauses sends when the WS send queue exceeds a high-water mark, resuming when it drops below a low-water mark. Defaults: 4MB high-water, 1MB low-water, 50ms drain-poll interval. Configurable via `configure({ upload: { highWaterMark, lowWaterMark } })`. Keeps the browser send buffer bounded regardless of file size: a 1GB upload over a slow connection no longer materialises 1GB in the browser's send queue, which used to manifest as memory pressure on the tab and stalled UI rendering. Pacing is graceful on `cancel()` (the wait loop exits promptly and the cancel-control-frame still goes out), on disconnect, and on terminal close. Falls back to the previous unbounded-queue behaviour when the adapter does not expose `bufferedAmount` (older versions). Three new tests pin: pacing kicks in when `bufferedAmount > highWaterMark` and resumes when it drops below `lowWaterMark`, no-op when `bufferedAmount` is undefined, exit-promptly on cancel during pace.

### Changed

- **`peerDependencies` bump: `svelte-adapter-uws` `^0.5.0-next.17` -> `^0.5.0-next.19`.** Picks up four `live.upload`-shaped additions from the adapter: (1) the default `maxPayloadLength` raise from 16KB to 1MB, which lets `live.upload`'s auto-discovery upgrade chunk sizes from 12KB to ~943KB on the second upload onwards (~80x throughput improvement on subsequent uploads vs the conservative default); (2) `platform.maxPayloadLength: number` and `platform.bufferedAmount(ws): number` for backpressure-aware framework code; (3) `conn.bufferedAmount` getter on the client connection object, used by this release's paced-sending feature. Apps still on adapter `next.17` or earlier need to bump their adapter dep when they upgrade this one; the auto-discovery and paced-sending fall back to safe defaults if not present.

- **`live.upload` Vite plugin client-stub generation for `live.upload()` exports.** Mirrors the existing `live.binary` detection: regex-detect `export const NAME = live.upload(...)` in the live folder, emit `export const NAME = __upload('module/NAME');` in the generated client stub, and emit a typed `.d.ts` declaration `export const NAME: (source: Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>, ...args: any[]) => UploadHandle<any>;` referencing the new `UploadHandle<T>` interface from `svelte-realtime/client`. Three contract tests pin: client-stub generation for upload exports, mixed binary + upload in the same module, and `.d.ts` emission with the `UploadHandle` import. With this, the public surface is one import: `import { avatar } from '$live/uploads'` then `await avatar(file, name, mime)` - no client wiring, no path strings to keep in sync, full editor autocompletion on the typed callable.

- **Auto-discovery of adapter `maxPayloadLength` for upload chunk sizing.** The server reads `platform.maxPayloadLength` on first contact and piggybacks it as `__cap` on the first upload-response envelope per WS (tracked via `WeakSet`, omitted on subsequent responses to keep the wire clean). Client caches the value globally and computes `chunkSize = floor(maxPayloadLength * 0.9)` on every new upload, so the SECOND upload onwards uses near-optimal chunks without any user configuration. The first upload uses the conservative 12KB default. User-configured `configure({ upload: { chunkSize } })` always wins over discovery - explicit beats auto. Two server tests pin: `__cap` appears in the first response when `platform.maxPayloadLength` is set, and is omitted on subsequent responses to the same WS. Four client tests pin: 12KB default is used pre-discovery, post-discovery uploads use 90% of the announced cap (verified by chunk-count behaviour on a 800KB payload), user-configured wins over discovered, and a late response (after handle settled via cancel) still updates the cache for future uploads. The cap is also extracted at the listener level (not the handle level), so cancelled uploads' late server responses still teach the client about the server's frame size. Net effect: configure-free deployments get optimal chunk sizes after one round-trip; on a 1MB-cap adapter that's an 80x throughput improvement on subsequent uploads vs the conservative default.

- **Client-side `__upload(path)` factory + `UploadHandle` for streaming uploads.** The browser counterpart to the server-side primitive. `__upload(path)` returns a callable: `(source, ...args) => UploadHandle` where `source` is `Blob` / `File` / `ArrayBuffer` / any `ArrayBufferView` / `ReadableStream<Uint8Array>` and the rest of the positional args are forwarded to the server handler exactly like a normal RPC call. The handle is a thenable (`await handle` resolves with the server's return value or rejects with `RpcError`), an event emitter (`handle.on('progress' | 'complete' | 'error' | 'cancel', cb)` returning an unsubscribe), and abortable (`handle.cancel(reason?)` sends a `0x02` cancel frame and rejects with `RpcError('CANCELLED')`). Synchronous getters for `sent`, `total`, `chunks`, `progress` (0..1, undefined when total isn't known), `bytesPerSec` (smoothed over the last second), and `streamId` / `streamIdHex` for log correlation. Auto-starts on creation but pump kickoff is microtask-deferred so listeners attached on the same line as construction never miss early events. AbortController integration is one line: `ac.signal.addEventListener('abort', () => handle.cancel())`. Source normalisation handles all five input types via a single `_chunkUploadSource` async-iterator - Blob slicing is lazy (no full materialisation), `ReadableStream` is re-chunked to a fixed `chunkSize` so the producer's chunk boundaries don't matter, source-iter throws are caught and surfaced as `RpcError('SOURCE_ERROR')` after a best-effort cancel-frame to the server. Disconnect mid-upload rejects with `RpcError('DISCONNECTED')` in step with how RPCs are drained today; terminal close (`conn.ready()` rejection) drains uploads similarly with the underlying error code (`CONNECTION_CLOSED`). Default chunk size is 12KB - chosen to fit comfortably under the current `svelte-adapter-uws` `maxPayloadLength` cap (16KB) with room for the 12-byte frame header and the args JSON; raise via `configure({ upload: { chunkSize: 1024 * 1024 } })` once the adapter cap is bumped or auto-discovered. Sixteen contract tests pin: single-chunk happy path, multi-chunk with sequential `seq` and `isLast` only on the last frame, empty source emits one chunk-0-with-isLast frame and no payload, all five source types round-trip correctly, server error response surfaces the right `RpcError.code`, `cancel()` sends the `0x02` frame and rejects, disconnect rejects in-flight uploads, progress events carry `sent / total / percent / chunks`, `complete` / `cancel` / `error` event ordering is `cancel -> error`, AbortController integration via `cancel()`, concurrent uploads get unique streamIds, envelope routing ignores unknown streamIds, unsupported source types surface as `SOURCE_ERROR`. The Vite plugin client-stub generation lands in a later release; until then, hand-roll `const avatar = __upload('routes/avatars/upload/avatar')` next to your handler imports.

- **`live.upload(handler, options)` - streaming uploads as a first-class primitive (server-side).** New top-level registration alongside `live.binary` for the streaming case where `live.binary`'s atomic-one-frame contract starts to hurt: file uploads, large protobuf bundles, anything where the client wants progress, cancellation, and bounded server memory rather than "buffer the whole thing then call the handler". Wire format is a compact 0x01 chunk frame (10 bytes overhead per chunk, 0.015% on 64KB chunks) with chunk 0 carrying the rpc path + args header, plus a 0x02 control frame for client-side cancellation. Server side handles routing, capacity caps, async-iterable wrapping, abort plumbing, and cleanup-on-disconnect. Handlers consume `for await (const chunk of ctx.stream)` and return a JSON-serialisable result like a normal RPC; `ctx.signal` is an `AbortSignal` that fires on client cancel, WS close, or any cap exceeded mid-stream. Three caps with sensible defaults: `maxSize` (per-upload byte cap, 100MB), `maxConcurrentPerSession` (4), `maxConcurrentTotal` (unbounded; opt-in for capacity protection). A `maxBufferedChunks` cap (64) bounds memory if the handler stops draining. Pending-phase memory is bounded by 16MB / 64 chunks while the handler is being resolved so an unauthenticated client can't dump bytes at a non-existent path before path-resolution rejects. Frames with reserved flag bits are dropped (forward-compat for future flags). Drains in-flight uploads on the existing `close(ws, ctx)` hook so a single `export { close } from 'svelte-realtime/server'` wires everything as before. 18 contract tests pin: single-chunk happy path, multi-chunk arrival order, empty upload, positional args, out-of-order rejection, duplicate streamId, NOT_FOUND, "not an upload endpoint", initial / mid-stream PAYLOAD_TOO_LARGE, cancel via control frame (with handler signal aborting), connection close (with handler signal aborting), `maxConcurrentPerSession`, `FLOW_BACKPRESSURE`, LiveError propagation, INTERNAL_ERROR no-leak path, malformed-frame drop (reserved bits), and interleaved multi-stream routing per-WS. Client convenience wrapper + Vite plugin stub generation land in upcoming slices; until then, raw-frame access works and the test suite is the canonical wire-format reference.

- **`live.notify(target, event, data)` for fire-and-forget server-initiated delivery** - the counterpart to `live.push` for cases where the caller doesn't need a reply (progress notifications, "upload complete" pings, "new message available" hints, cron-driven price ticks fanned out to many users). Returns `Promise<void>` that resolves once the envelope is dispatched. Never rejects in normal operation: offline user, timeout, client handler error, cluster-route failure - all silent by design. The caller chose `notify` exactly because they don't want to deal with delivery state. Validation throws synchronously for programming errors (bad target, empty event name) - those are bugs at the call site, not request failures, and should surface loud. Wire shape is identical to `live.push` today (same `onPush(event, handler)` dispatcher client-side); the implementation discards the reply via a bounded internal timeout. When the adapter ships a true no-reply primitive in a future release, internals swap with no caller-side change. The `live.push` validation error message now points at `live.notify` directly so users hitting `live.push({ timeoutMs: 0 })` (which throws because `timeoutMs` must be positive) get a one-line fix, instead of the silent foot-gun where wrapping the throw in `.catch(() => {})` swallowed it and the push never fired.

## [0.5.0-next.12] - 2026-05-08

### Added

- **`configureCron({ bus })` for cluster-wide cron fan-out.** Mirror of `configurePush({ remoteRegistry })` for the cron path. With a leader configured, only the elected worker fires - but until this slice that worker's publishes only reached uWS subscribers on its own process; subscribers on non-leader instances saw nothing because no other worker independently produced the publish. The new `bus` field on `configureCron` plugs in the extensions-package pubsub bus (`svelte-adapter-uws-extensions/redis/pubsub` or `redis/sharded-pubsub`) so every cron fire wraps the captured platform with `bus.wrap(platform)` before publishing - both the `return value` auto-publish AND the cron handler's `ctx.publish(...)`. Wraps fresh per fire (cheap object-literal allocation, only happens at cron firing rate - 1Hz worst case for 6-field schedules) so any platform / bus mutation is picked up live without caching staleness. svelte-realtime consumes the bus structurally as `{ wrap(platform): wrapped }` - the same single-method shape used for `PushRemoteRegistry` - so any pubsub primitive that conforms works; the realtime layer never imports the extensions package directly. Why this is cron-specific: derived / aggregate watchers re-publish through the realtime-wrapped `platform.publish` captured at activation time, and every instance sees the source-topic firehose via its own bus subscriber and computes derived locally; bus-relaying derived publishes would cause double delivery. Cron is different because only the leader fires it, so the leader's publish must relay or remote subscribers see nothing. Single-instance dev (no `bus`, no `leader`) keeps using the raw platform with zero overhead.

- **Warn-once diagnostic for `configureCron({ leader })` without `bus`.** Setting `leader` declares cluster intent; not also wiring a `bus` means leader-only cron ticks publish on the elected worker only and remote subscribers will see nothing. Almost always a configuration bug. The warning fires once per process at `configureCron` call time, dev-only, with a pointer to the cluster-cron documentation; reset by `_clearCron` so HMR / tests get a fresh slate. Suppress via fixing the wiring rather than via a flag.

### Changed

- **`configureCron` now accepts a partial config**: at least one of `leader` or `bus` must be present (the previous "leader is required" rule has loosened to "either field, or both"). `configureCron({ bus })` alone is a valid shape for clustered apps that want the cron fan-out but stay single-firing-everywhere (uncommon but valid). Existing call sites that pass `{ leader: ... }` are unchanged. The validation error message updated from `"config must include a leader field"` to `"config must include at least one of leader or bus"`.

- **`peerDependencies` bump: `svelte-adapter-uws` `^0.5.0-next.15` -> `^0.5.0-next.17`.** Picks up two pure bug-fix releases from the adapter that downstream consumers of this package will hit: (1) **next.16** - `client.send` and `client.sendQueued` no longer mangle `ArrayBuffer` and `ArrayBufferView` payloads into the literal text `'{}'` via `JSON.stringify`. The mangling silently broke every `live.binary` RPC end-to-end - binary frames reached the wire as 2-byte text, the server's `handleRpc` failed its envelope check, the client-side promise hung to its 30s timeout. Pure unblock for the binary path with zero behavior change for current text callers. (2) **next.17** - the adapter's Vite plugin no longer drops its `ws-handler` entry under SvelteKit + Vite 7's environment API. Pre-fix, every shared module imported by both `hooks.ws` and SvelteKit routes was duplicated in the build output (each with its own singleton state); concrete impact for production deployments using Prometheus metrics: a registry exported from `src/lib/server/metrics.js` and imported by both `hooks.ws` (where this package's `wirePublishRateMetrics` and `connectionMetricsHook` write counters) and a `/metrics` route (where `metrics.export()` serializes them) became two disjoint registries - the `/metrics` scrape returned headers but no values. Same shape for any in-memory cache, leader-election state, or other singleton shared between hooks.ws and routes. No code change is required on this package's side - the bumped peer-dep range just documents which adapter version unblocks the canonical metrics-route + cluster-cron demo wiring.

## [0.5.0-next.11] - 2026-05-07

### Fixed

- **`pushHooks.close` now drains stream-subscription bookkeeping in addition to the push registry, so a single hook re-export covers both concerns.** The `live.push` JSDoc and README examples have always recommended `export const close = pushHooks.close;` as the canonical wiring - but `pushHooks.close` was push-only, leaving stream-subscription bookkeeping (`_topicWsCounts`, silent-topic watchdogs, `__onUnsubscribe` callbacks) un-drained. In short-lived test pages and e2e flows this manifested as a 30s-delayed flurry of `[svelte-realtime] Topic 'X' has subscribers but no events arrived within 30000ms` warnings firing AFTER every page closed - one warning per topic the page had subscribed to. The disarm path itself was already correct (`_disarmSilentTopicWatch` at `server.js:746`, wired into both per-topic unsubscribe and hard-close at `server.js:1133` and `server.js:6406`); the gap was that the realtime `close` hook never ran for users who followed the JSDoc example. Two-line fix: (1) the realtime `close(ws, ctx)` now also drains the per-userId push registry, so a single `export { close } from 'svelte-realtime/server'` covers everything; (2) `pushHooks.close(ws, ctx)` routes through the realtime `close` when the adapter passes `ctx` (production), so the existing JSDoc-style `export const close = pushHooks.close` re-export gets the same full cleanup with no doc-ordained migration. Direct one-arg `pushHooks.close(ws)` calls (tests, custom flows) still work as push-only via a fallback branch. Idempotent across repeat calls and across users who explicitly compose both hooks; both registries are clean either way. Six new contract tests pin: pushHooks.close drains the silent-topic watchdog under ctx; pushHooks.close drains push registry; pushHooks.close(ws) without ctx still drains push (legacy call shape preserved); realtime `close(ws, ctx)` drains push too; manual composition of both is idempotent; ctx-omitted call doesn't crash on missing platform.

### Changed

- **`devDependencies` bump: `svelte-adapter-uws-extensions` `^0.5.0-next.6` -> `^0.5.0-next.8`.** Picks up `createLeader(redis, options?)` from extensions next.7 (the canonical implementation already referenced from this package's `configureCron({ leader })` JSDoc and README) and the task-runner observability surface from extensions next.8 (`tasks.ready/list/counts/takeover`, `onStateChange` callback, `createPgClient({ pool })` overload - not consumed by this package directly, but available downstream now). All 1077 tests continue to pass under the new dev-dep tree.

- **`peerDependencies` bump: `svelte-adapter-uws` `^0.5.0-next.14` -> `^0.5.0-next.15`.** Aligns the peer-dep range with the `init({ platform })` and `shutdown({ platform })` lifecycle hooks shipped in adapter next.15, which this package's `0.5.0-next.8` documented as the canonical wire-up site for `setCronPlatform` and `live.configurePush({ remoteRegistry })`. Apps still on adapter next.14 need to upgrade their adapter dep when they upgrade this one; the legacy `open(ws, platform)` wire-up path still works on either adapter version.

## [0.5.0-next.10] - 2026-05-07

### Fixed

- **`_activateDerived(platform)` from `init({ platform })` now installs the publish-wrap for static aggregates / effects / derived too, not just dynamic-derived.** Latent bug surfaced by `0.5.0-next.9`'s windowed-aggregate adoption pattern (the canonical `/demos/topk` shape - one cron firehose feeding a windowed aggregate, with no client connections active during the boot window). Previously: `_activateDerived` early-returned when every source-watch index was empty; the static aggregate / effect / derived registration paths populated those indices later (via the lazy queue draining on first cron tick / RPC, or via the dev-mode SSR-load fallback) but had no late-activation hook to install the wrap retroactively. Only the dynamic-derived bind path had that hook (an open-coded copy at the per-instance bind site). Cron-driven publishes that fired before the first WS connection silently bypassed every watcher; manifest as empty leaderboards plus a `silentTopicWarning` after 30s. Two-part fix: (1) a new `_maybeLateActivate()` helper installs the wrap when a registration lands after `_activateDerived` ran against an empty registry, called from `__registerAggregate` (single-state and windowed paths), `__registerEffect`, the static branch of `__registerDerived`, and the existing dynamic-derived bind path (open-coded copy replaced with the helper for DRY). (2) An eager `_hasLazyReactive` flag is set the moment any reactive registration hits the lazy queue (mirrors the pre-existing `_hasDynamicDerived` flag's behavior, which had this signal for derived but not for aggregate / effect); `_activateDerived`'s gate consults it so the wrap installs synchronously in `init` rather than waiting for the lazy queue to drain. The two parts are belt-and-braces: the eager flag handles the canonical `init -> first cron tick` flow; the helper handles direct-registration paths and any timing edge that escapes the eager flag. Both are idempotent against `_activatedPlatforms`. Failure mode if the user never calls `_activateDerived` is unchanged: no wrap installs (the helper short-circuits on `!_derivedPlatform`), and the existing missing-`_activateDerived` warning at first dynamic-derived subscribe still fires. Eight contract tests pin: post-activate registrations for aggregate / windowed aggregate / static derived / effect all receive publishes; lazy-queue + activate-during-the-window installs the wrap; multiple registrations don't double-wrap; never-activate stays unwrapped; dynamic-derived bind path still works through the shared helper.

## [0.5.0-next.9] - 2026-05-07

### Added

- **`live.aggregate({ windows })` for native time-windowed aggregations.** New optional `windows` config maintains one state slice per declared window with its own output topic at `${topic}:${windowName}`, replacing the 4-registrations-and-hand-rolled-bucketing dance every leaderboard / trending / activity-feed surface previously required. Three window types ship: `lifetime` (never resets; named output for symmetry), `tumbling` (boundary-anchored via `period: 'minute' | 'hour' | 'daily' | 'monthly'` with optional `tz` for IANA-zoned boundaries, or `durationMs + anchor` for arbitrary fixed periods anchored to a custom epoch), and `sliding` (hop-window with `durationMs + slideMs` partitioning state into `ceil(durationMs / slideMs)` buckets, rotating on each slide tick). On boundary cross the closing tumbling window publishes one final pre-reset state before `init()` clears it for the new window. Sliding windows are not snapshot-restorable (the hop ring is tied to wall-clock time); tumbling and lifetime accept per-window restore via the new `snapshots: { [windowName]: () => Promise<state> }` option that hydrates in parallel during registration. Per-window debounce overrides via `WindowSpec.debounce` (e.g. zero on `last10min` for real-time trending, 100ms on `today` where staleness does not matter). Boundary calculation uses `Intl.DateTimeFormat` for DST-correct, leap-day-correct, leap-second-irrelevant zone arithmetic with no third-party dependency. Both runtime stub generation and `.d.ts` emission in the Vite plugin handle the namespace-object shape so `import { trending } from '$live/topk'; trending.last10min.subscribe(...)` Just Works on the client; SSR stubs follow the same namespace shape with one `readable(undefined)` per window. Strict superset of the current API: `windows` defaults to absent and the single-state path is unchanged.

- **`combineSum` / `combineMax` / `combineMin` / `combineCounts` / `combineMerge` exports** from `svelte-realtime/server`. Pass any of these as a reducer's `combine` field for sliding windows - they cover the common reducer state shapes (number sum, number max/min, `Record<string, number>` aggregation, last-write-wins object merge). Hand-roll your own `combine(...buckets)` for non-trivial reducers (top-K, percentile sketches, custom shapes) - the escape hatch is fully intact.

- **`MAX_AGGREGATE_BUCKETS` capacity cap** (default 1000) caps a single sliding window's hop-bucket count. Validated at module-load time with a clear error pointing at the offending window name; refuses to register so a mistake like "1ms slide on a 1s window" never silently allocates an oversized ring. A 10-hour sliding window with 1-minute slides uses 600 buckets, well under the cap.

- **Module-load validation for windowed aggregate configs.** Sliding windows without a `combine` on every reducer that has `reduce` throw at registration with the offending field name and a pointer to the built-in helpers. Tumbling specs require exactly one of `period` or `durationMs`. Unknown `type` values throw with the supported set in the message. Failing fast at module load is the difference between "the demo never boots and prints a clear stack trace" and "the demo boots and silently drops events into a non-existent bucket array."

### Documentation

- **README "Time windows" section under Aggregates** documents the three window types, the `combine`-helpers table, per-window snapshot semantics, the cluster-mode constraint (fanout-to-every-worker source topics required for cross-worker convergence; sharded sources will diverge until a future `configureAggregate({ leader })` lands), and the capacity bound.

## [0.5.0-next.8] - 2026-05-07

### Added

- **`configureCron({ leader })` for cluster-mode cron leader-election.** New top-level export gates the cron tick on a synchronous `() => boolean` predicate. Without it (the default), every worker fires every registered job on every matching tick - the correct single-process and dev behavior. With it, only the worker whose `leader()` returns truthy proceeds to evaluate per-job schedules; the rest exit the tick with a `cron{status:'not-leader'}` metric increment. svelte-realtime intentionally does not bundle the leader implementation - the cluster transport (Redis or otherwise) is downstream of the realtime layer. Canonical implementation lands in `svelte-adapter-uws-extensions/redis/leader` (Redis SETNX lease with background renewal); this slice ships only the consumption hook so the realtime package stays Redis-free for single-process apps. Pass `null` (in place of the whole config) to clear and revert to the default. Failure modes: a throwing `leader()` is fail-closed (skip the tick, `cron{status:'leader-error'}` metric, `console.error` in dev) - better to miss a tick than to double-fire because the leader-election machinery is broken; a non-boolean falsy return is treated as "not leader." Documented for both cluster styles svelte-adapter-uws supports: `CLUSTER_MODE=reuseport` on Linux (N kernel workers per replica) and acceptor mode on Windows / macOS (N internal workers per process), with multi-replica Docker compounding the count.

### Changed

- **`setCronPlatform` and `live.configurePush({ remoteRegistry })` recommended call site moved from `open(ws, platform)` to `init({ platform })`.** Requires `svelte-adapter-uws >= 0.5.0-next.15`, which adds the `init` lifecycle hook that fires once per worker after the listen socket is bound and before any upgrade / open / message hook runs. Calling these from `init` eliminates the boot-to-first-connect window where cron ticks were no-ops and `live.push` could not reach cross-instance users. README and JSDoc for both functions now lead with the `init` example; the legacy `open` call site continues to work and is documented as the fallback for older adapter versions. No code change is required to keep working on older adapters; the recommendation is purely about the canonical example users will copy when wiring fresh.

### Fixed

- **`live.configurePush()` typings now accept `remoteRegistry` and treat both fields as optional.** `server.d.ts` typed `identify` as required and omitted `remoteRegistry` entirely, so the documented cluster-routing call shape (`live.configurePush({ remoteRegistry: registry })`) hit a TS error on the load-bearing line of every README copy-paste, and identify-less identify-only callers had to assert their way past a phantom required field. The runtime accepts either field individually and rejects only when neither is present (a `{}` argument). Typed surface now mirrors that contract via a discriminated union: `{ identify: ...; remoteRegistry?: ... } | { identify?: ...; remoteRegistry: ... } | null`, so `live.configurePush({})` becomes a compile-time error and `live.configurePush({ remoteRegistry: registry })` typechecks cleanly. The new structural `PushRemoteRegistry` interface describes the consumed surface (`request<TReply>(target, event, data?, options?)`) without taking a hard import dependency on `svelte-adapter-uws-extensions/redis/registry`, so any registry implementation that conforms is accepted.

- **Vite plugin classifies single-arity `(ctx) => topic` topic-fns as static streams instead of dynamic factories.** `_isDynamicExport` previously returned true for any function-form first argument regardless of arity, so the natural per-user / per-tenant shape `live.stream((ctx) => 'events:' + ctx.user.id, async (ctx) => loadEvents(ctx.user.id), { merge: 'set' })` produced a factory-shaped client stub typed as `((...args: any[]) => StreamStore<any>) & { load(...) }` - which the type-checker rejected on `myStream.subscribe(...)` and which threw `TypeError: myStream.subscribe is not a function` at runtime in plain JS. The stub is now arity-aware via the existing `_isCtxParam` check, mirroring the server's existing `_callTopicFn` / `_tagTopicFn` arity-dispatch contract: 0-param topic-fns and 1-param ctx-only topic-fns (named `ctx` / `context` / `_ctx`, or typed as `Ctx` / `Context` / `RequestContext` / `ServerContext` / `LiveContext`) are static; everything else (1 non-ctx param, 2+ params, destructured first param) stays dynamic. Beyond fixing the broken client stub, this removes the security footgun the previous workaround invited: pushing the userId out to a client-supplied arg required a hand-rolled `if (userId !== ctx.user?.id) throw new LiveError('FORBIDDEN', ...)` identity check that the type system could not enforce, and forgetting it let any client subscribe to any user's stream by passing the target userId. The static `(ctx) => topic(ctx.user.id)` form is secure-by-construction: the topic is computed server-side from the authenticated `ctx.user`, with no client-controllable parameter that could be tampered with. Applies to `live.stream`, `live.channel`, and `live.derived` across both runtime stub generation and `.d.ts` emission. 10 new tests in `test/vite.test.js` cover: `(ctx) => topic`, `()` zero-param, `(context)` / `(_ctx)` alternate names, `(ctx: LiveContext)` typed, async `(ctx) => ...`, non-arrow `function (ctx) { ... }`, `(roomId)` single non-ctx param staying dynamic (server interprets as omitted-ctx + 1 client arg), `({ roomId })` destructured staying dynamic via the existing safe fallback, and `.d.ts` emission confirming `StreamStore` rather than the factory shape.

- **`live.cron` "fired but no platform captured" warning is now deduped to once per process lifetime.** With a 6-field schedule registered the tick runs at 1Hz, so before this fix a server idle from boot until the first WebSocket connection emitted this warning every second - producing hundreds of identical lines in stderr that drowned out other diagnostics. The warning now fires once and stays silent until `setCronPlatform(platform)` is called or `_clearCron` resets state (HMR / tests). Reset on platform capture so a defensive future platform-loss re-arms it; reset on `_clearCron` so test isolation is preserved. The warning copy is also updated to point at the `init({ platform })` hook (svelte-adapter-uws >= 0.5.0-next.15) as the canonical wire-up site, with the older `open(ws, platform)` hook called out as the fallback. Pre-existing behavior of `_IS_DEV`-gating the warning is unchanged - production never saw the spam.

## [0.5.0-next.7] - 2026-05-06

### Added

- **`live.cron` accepts 6-field expressions for sub-minute schedules.** A leading seconds field unlocks Quartz / node-cron-style sub-minute granularity: `live.cron('*/3 * * * * *', 'tick', ...)` fires every 3 seconds, `live.cron('30 * * * * *', 'half-min', ...)` fires at second `:30` of every minute. 5-field expressions parse and behave unchanged. Once any 6-field schedule is registered the cron tick adapts from 60s to 1Hz (sticky for the process lifetime; cleared by `_clearCron` for HMR). 5-field schedules running under the 1Hz tick fire only at second `:00` of any matching minute, so they keep their once-per-matching-minute semantics instead of bursting 60 times. Internal: `__cronParsed` is 5-element for 5-field input and 6-element for 6-field input; existing introspection of `__cronParsed[0]` (the minute matcher) on 5-field schedules is unchanged. Sub-second schedules are out of scope for cron syntax; a future `live.interval(ms, fn)` will be the primitive for that.

### Fixed

- **`live.cron` no longer fires concurrently with itself.** Previously a long-running cron handler whose schedule matched again before it finished would be invoked again in parallel (masked at the prior 60s tick because most jobs finish within a minute, but a real concurrency bug all the same). The tick now skips a path whose previous invocation is still in flight and increments `cronCount{status: 'skipped'}` so the overlap is visible in metrics. Single-flight applies to both 5-field and 6-field schedules.

## [0.5.0-next.6] - 2026-05-05

### Security

- **Stream-RPC subscribes now consult the adapter's wire-level subscribe gate.** A `live.stream`/`live.room` subscribe used to run the loader, deliver its initial data, and (for rooms) publish the presence `'join'` event BEFORE the adapter's `subscribe` / `subscribeBatch` hook chain ever fired - because that hook only fires on the client's follow-on `subscribe-batch` wire frame, which arrives AFTER the stream RPC has already returned. Apps gating private rooms via `subscribeBatch` (rather than via `live.stream({ access })` / `live.room({ guard })`) saw their loader output reach denied users, and `_presenceRef` accumulated phantom entries (one per denied visit, since the rollback path was unreachable - nothing threw). For rooms with `init` returning `[]` the impact was cosmetic; for any non-trivial loader, it was a real data leak. `_executeStreamRpc` now calls `platform.checkSubscribe?.(ws, topic)` after `__streamFilter` and admission checks but before `ws.subscribe(topic)`, `__onSubscribe`, and the loader. A truthy denial early-exits with `{ ok: false, code: <denial>, error: ... }`. The `?.` keeps older adapters working: when the method isn't there (pre-`0.5.0-next.14`), the new gate degrades to current behavior and the in-realtime gates remain the only stream-RPC access checks. New regression tests cover (1) `FORBIDDEN` denial blocks loader/subscribe/onSubscribe; (2) `UNAUTHENTICATED` surfaces the right code+message; (3) older adapter (no `checkSubscribe`) degrades correctly.

### Changed

- **`svelte-adapter-uws` peerDependency bumped from `^0.5.0-next.10` to `^0.5.0-next.14`.** Required for the `platform.checkSubscribe` gate above. The adapter side ships the new method in `0.5.0-next.14` along with the matching `runSubscribeHook` / `runSubscribeBatchHook` precedence (batch hook wins, falls back to per-topic).

## [0.5.0-next.5] - 2026-05-05

### Fixed

- **`live.room` zero-config presence now shows the user themselves.** A subscriber alone in a room used to see presence count 0, and two users would each see only the other (never themselves). The race: the data stream's `onSubscribe` publishes a `join` to `${topic}:presence` synchronously, and only THEN does the client subscribe to that presence topic, so the user's own join was missed. The presence stream's init only consulted `platform.presence.list`, which isn't wired in zero-config dev. The init now falls back to reconstructing the roster from the in-memory `_presenceRef` map when `platform.presence.list` isn't a function. To make the reconstruction possible, `_presenceRef` entries now carry the user-supplied presence payload alongside `count` and `timer`. Production stays unchanged: when a Redis-backed `platform.presence.list` is wired, the fallback is bypassed and cluster-wide consistency takes over. New regression tests under `live.room()` cover the single-user and two-user cases.

### Added

- **`MAX_PRESENCE_REF` exported as a tunable cap (default 1,000,000).** The in-memory presence-ref map (`_presenceRef`) now joins the documented capacity-model taxonomy alongside `MAX_PUSH_REGISTRY`, `TOPIC_WS_COUNTS_WARN_THRESHOLD`, etc. Saturation behavior: entries with a pending leave timer are evicted first; if still full, the new join is dropped silently (no entry created, no `'join'` published) and a one-shot warning surfaces pointing at `platform.presence` wiring. The cap was previously an unexported `10_000` internal that bounded only refcount bookkeeping. Now that it backs the zero-config presence-roster fallback added above, it's correctness-load-bearing and deserves the same surface as the other caps. Wired into `_setCapsForTest({ presenceRef })` for fast saturation tests, and documented in the README "Capacity model" section.

## [0.5.0-next.4] - 2026-05-05

### Fixed

- **`live.stream` no longer fires a spurious unsubscribe + refetch on the first WS open.** When a stream subscribed during page hydration (the common case, since `_connect()` is lazy on the first subscriber), the WS was usually still `'connecting'` at that moment. The internal `firstStatus` flag flipped on the synchronous `'connecting'` callback, so the next transition to `'open'` - the actual first connect, not a reconnect - entered the reconnect branch and produced the wire sequence `subscribe -> subscribed -> unsubscribe -> __rpc(replay:true) -> subscribe -> subscribed`. Every stream paid one extra RPC round trip per page load, and `replay: true` streams immediately transitioned into resume-mode on first connect, masking the fresh-subscribe path. The status listener now filters on `'open'` first and tracks "has been open at least once" instead of "have we seen any callback", so the first `'open'` is the lifetime baseline. New regression test `__stream() initial-connect status handling` exercises the previously-uncovered mid-connect subscribe path; the existing test mock unconditionally fired `'open'` synchronously, which is why no test caught this before.

### Internal

- **`key` default no longer leaks onto non-`crud` streams.** `live.stream`, `live.channel`, `live.derived`, `live.aggregate`, plus the matching client-stub emitters in `vite.js` (`_extractStreamOptions`, `_extractChannelOptions`, `_extractRoomInfo`, plus the per-derived/aggregate/room `__stream(...)` literals) now only stamp `key: 'id'` when the merge strategy is actually `crud`. `set` and `latest` ignore key entirely; `presence` and `cursor` use a fixed `'key'` field on the data shape, not the option. Stamping the default everywhere just bloated each subscribe response with `"key":"id"` (~8 bytes per subscribe per non-crud stream). User-specified keys still flow through unchanged. Test `live.channel "uses default options"` updated to `{ merge: 'set' }`. No public-API change; client behavior unchanged because the client's runtime defaults already cover the omitted key.

## [0.5.0-next.3] - 2026-05-03

### Fixed

- **`live.metrics()` documentation now matches a working integration.** Backport of the `0.4.23` fix from `main`: the README's "Prometheus metrics" example imported a non-existent `createMetricsRegistry` from `svelte-adapter-uws-extensions/prometheus`, and the `server.d.ts` JSDoc example imported a non-existent `createRegistry`. The real export is `createMetrics`, and its registry methods take positional args (`counter(name, help, labelNames)`) where `live.metrics()` calls them with options-object form (`counter({ name, help, labelNames })`). The README now shows a six-line adapter that bridges the two and is paired with `metrics.handler` for the `/metrics` endpoint. JSDoc and type declarations updated to match.

### Added

- **`MetricsRegistry` interface in `server.d.ts`.** Backport of `0.4.23`. TypeScript users now get autocomplete and structural validation on the registry shape passed to `live.metrics()`, replacing the previous `registry: any` signature.
- **Integration test exercising the real extensions registry.** Backport of `0.4.23`. `test/server.test.js` now imports `createMetrics` from `svelte-adapter-uws-extensions/prometheus` and runs the documented adapter shim against it, asserting that RPC counters, the duration histogram, the error counter, the stream subscription gauge, and the cron counter all flow through to the registry's serialized output. The merge bumped the `svelte-adapter-uws-extensions` devDependency from `^0.4.2` (as pinned on `main`) to `^0.5.0-next.3` so it tracks the rest of the dev-line ecosystem.

## [0.5.0-next.2] - 2026-05-03

### Internal

- **`shared/` directory for cross-cutting helpers.** Mirrors the `svelte-adapter-uws-extensions/shared/` layout. New `shared/assert.js` is the single source of truth for the `realtime/`-prefixed `assert` / `getAssertionCounters` / `_resetAssertCounters` API exported from both `server` and `client`; the server wires its Prometheus counter via `wireAssertionMetrics(...)` from the metrics-init site. New `shared/merge.js` exports `mergeKeyField(merge, defaultKey)` and `rebuildIndex(value, index, merge, defaultKey)` so the `(merge === 'presence' || merge === 'cursor') ? 'key' : key` literal stops appearing in four places and the index-rebuild logic has one home. Tests, public API surface, and runtime behavior unchanged; the package's `files` array now includes `shared`.

- **`_executeSingleRpc` split into a stream / non-stream pair.** The 280-line monolith now hands the stream branch off to a module-level `_executeStreamRpc(ws, platform, fn, ctx, args, msg, subscribedRef)` helper. The catch-block rollback path now reads the subscribed-topic out of a `subscribedRef` container that the helper writes into on successful subscribe, so a throw mid-load still rolls back the registration. The non-stream branch keeps its original shape inline.

- **`vite.js` export-detection compressed.** The five wrappers whose client stubs and registry entries are identical (`live` / `live.validated` / `live.lock` / `live.idempotent` / `live.rateLimit`) now drive a single `for (const re of [...])` loop in both `_buildTopicsRegistry` and the SSR registry generator, replacing five copies of the same 8-line `RE.lastIndex = 0; while ((match = RE.exec(source))...)` block in each pass. Roughly 80 lines deleted; behavior unchanged.

- **`_topicInvalidationWatch` publish path now skips the regex engine on the common case.** Each pattern's compiled entry now carries its literal prefix and a `prefixOnly` flag (true for `prefix*` shapes). The publish hot path fast-fails with `topic.startsWith(entry.prefix)` before invoking `regex.test`, and skips the regex entirely when the pattern is `prefix*` and the topic has at least one character beyond the prefix. With N registered patterns and a high publish rate this turns N regex.test calls per publish into N startsWith calls plus regex.test only for the rare patterns that actually match the prefix.

- **`process.env.NODE_ENV !== 'production'` checks consolidated.** Sixteen inline `typeof process !== 'undefined' && process.env(?.)?.NODE_ENV !== 'production'` checks across `server.js` now reference the existing `_IS_DEV` constant. Minifier-friendly and single-source.

- **Dev-mode hoist in `_executeBatch`.** The lazy-resolve await is now called once at the top of a batch instead of once per entry; with 50-entry batches this drops 49 redundant microtask awaits.

- **Stale JSDoc cleanup.** An orphaned JSDoc block that had drifted onto `_trackStreamSub` was removed; the misplaced `close()` JSDoc that was sitting above `enableSignals` was reattached to the actual `close()` definition.

### Removed

- **Dead `pipe.filter().transformEvent` field.** `pipe.filter()` returned `{ transformInit, transformEvent }` but `pipe()` only ever consumed `transformInit`, so the `transformEvent` field had no effect at runtime. The README at the access-control section also incorrectly suggested `pipe.filter()` for per-event filtering. The dead field is removed from `server.js` and `server.d.ts` (`PipeTransform` no longer declares `transformEvent`); the README pointer now correctly directs per-event projection to the `transform` option on `live.stream({ transform })`. The pipe table at "Server transforms" was already correct (filter / sort / limit / join are all "Initial data only").

## [0.5.0-next.1] - 2026-05-03

### Fixed

- **Rooms now SSR-render correctly.** The Vite plugin's `_generateSsrStubs` collected stream-like exports from `[STREAM_EXPORT_RE, CHANNEL_EXPORT_RE, DERIVED_EXPORT_RE, AGGREGATE_EXPORT_RE]` but had no case for `ROOM_EXPORT_RE`, so SSR fell through to `export * from <serverPath>` which re-exported the SERVER-side `live.room()` namespace (with `__dataStream`, `__presenceStream` etc.) instead of the CLIENT-shaped namespace (with `data: factory(...)`, `presence: factory(...)`, etc.). Pages that rendered `board.data(boardId)` during SvelteKit SSR crashed with `TypeError: board.data is not a function` and returned 500. The SSR generator now emits a per-room namespace stub: `data` / `presence` / `cursors` are factory-shaped readables (returning `readable(undefined)` with `.hydrate()`) and actions are no-op `() => Promise.resolve(undefined)` so they don't break post-hydration handler wiring.

- **Derived / effect / aggregate watchers now fire on the batched fast path.** `_wrapPlatformPublish` only wrapped `platform.publish`; it left `platform.publishBatched` untouched. Since `ctx.publish` falls through to `platform.publishBatched` when no per-topic coalesce or transform is registered (the default with the uWS adapter), source-topic publishes from any RPC handler that took the batched path failed to trigger derived recomputes / effects / aggregate updates in production. Vitest never caught this because `mockPlatform()` has no `publishBatched`, forcing the unbatched code path. The wrap now installs on both methods, iterating each batch entry and firing watchers per topic.

- **`_activateDerived` now wraps the prototype platform, not the per-connection clone.** The svelte-adapter-uws handler exposes per-connection platforms as `Object.create(basePlatform)`. `_activateDerived(ctx.platform)` was wrapping the per-connection wsPlatform's own `publish`, so every other connection's inherited lookup walked the prototype chain to the un-wrapped base and bypassed the wrap entirely. The activator now resolves to the prototype when the prototype owns a `publish` function (the production path), and wraps the input directly when it doesn't (test mocks). Combined with the `publishBatched` wrap fix above, `live.derived()` now works correctly across multiple connected clients.

- **`live.webhook()` docstring corrected.** The previous comment claimed the Vite plugin auto-generates a SvelteKit `+server.js` endpoint for webhook exports. The plugin only marks them as known so they're not flagged "not wrapped in `live()`"; users are expected to wire the endpoint themselves by importing the handler and calling `.handle({ body, headers, platform })` from a POST handler. README "Webhooks" section already showed the correct pattern; only the JSDoc was misleading.

### Internal

- **Channels / rooms / cron / derived multi-page e2e** (24 new scenarios x 2 dev/prod = 48 cases, total e2e 78 → 168). New spec files: `test/e2e/{channels,room,derived,cron}.spec.js`. New fixtures: `test/fixture/src/live/{channels,room,derived,cronjobs}.js` plus matching pages under `test/fixture/src/routes/`. Channels coverage proves cross-client static + presence + dynamic-topic isolation. Rooms coverage proves data + presence + cursors + cross-client `addCard` action + auto-leave-on-disconnect (the latter required adding `close` and `unsubscribe` re-exports to `test/fixture/src/hooks.ws.js`; the existing fixture had no close hook so realtime's per-subscription cleanup never fired on WS drop). Derived coverage proves cross-client recompute fan-out, multi-source, debounce coalescing, dynamic per-arg isolation, and late-join initial-fetch hydration. Cron coverage proves auto-publish (return value -> `set` event), manual `ctx.publish`, multi-client fan-out, late-join, and a sanity check that cron is independent of pubsub triggers (uses an exported `_tickCron()` for deterministic firing instead of clock-minute alignment).

- **Multi-instance docker-compose chaos harness for cross-instance pubsub.** New `test/chaos/` directory with `docker-compose.yml` (one Redis container with OS-assigned host port, so it never collides with productive Redis instances on the same machine), `instance-server.js` (fixture prod-build entrypoint that reads `REDIS_URL` from env), `global-setup.js` / `global-teardown.js` (orchestrates docker compose up + spawns two svelte-realtime instances on OS-assigned ports), `multi-instance.spec.js` (5 scenarios), and a separate `playwright.config.js`. The fixture's `hooks.ws.js` now wires the extensions Redis pubsub bus when `REDIS_URL` is set: `bus.activate(platform)` in the `open` hook subscribes the local instance to incoming Redis fan-out, and `bus.wrap(platform)` in the `message` hook routes outgoing publishes through Redis + local. When `REDIS_URL` is unset, behavior is identical to the previous fixture (existing 168 e2e cases pass unchanged). New `npm run test:chaos` script. Fixture deps now include `ioredis` and `svelte-adapter-uws-extensions`.

### Added

- **Production assertions with structured metrics.** New `assert(cond, category, context)` helper exported from `svelte-realtime/server` and `svelte-realtime/client` instruments invariants at 7 hot-path sites (envelope shape on incoming RPC frames, subscription bookkeeping consistency, push-registry compare-and-delete, lock-waiter shape, optimistic-queue server-state pairing, drain-precondition, settle entry shape). On violation: increments a per-category in-memory counter (read via `getAssertionCounters()`), fires the new Prometheus counter `svelte_realtime_assertion_violations_total{category}` when `live.metrics(...)` is wired, and logs a `[realtime/assert] {...}` line. In test mode (`VITEST` or `NODE_ENV=test`) the assert throws so vitest surfaces the failure; in production it does NOT throw because a thrown exception inside a publish hot-path microtask could leave a half-applied bookkeeping update. Categories are stable strings prefixed `realtime/<module>.<invariant>` so the Prometheus label cardinality is bounded (~7 today) and does not collide with the adapter's `extensions_assertion_violations_total`. README "Production assertions" section documents every category and their site.

- **Bounded-by-default capacity caps with documented saturation behavior.** Five new caps surface a "Capacity model" section in the README that maps every internal Map / Set / array with caller-driven growth to a default value plus a saturation behavior (REJECT, WARN-ONLY, FIFO-evict, or WARN-then-skip). New exports from `svelte-realtime/server`: `MAX_PUSH_REGISTRY` (10,000,000, WARN-then-skip on the per-userId connection registry), `TOPIC_WS_COUNTS_WARN_THRESHOLD` (1,000,000, WARN-only on the per-topic subscriber index since eviction would corrupt routing), `SILENT_TOPIC_WARN_DEDUP_MAX` (1,000,000, FIFO-evict), `PUBLISH_RATE_WARN_DEDUP_MAX` (1,000,000, FIFO-evict). New export from `svelte-realtime/client`: `MAX_OPTIMISTIC_QUEUE_DEPTH` (1,000, REJECT). All five mirror the canonical sizing from svelte-adapter-uws + svelte-adapter-uws-extensions so an app reading docs across the three packages sees consistent scales. Existing caps (rate-limit identities, throttle/debounce timers, idempotency results, presence refs, history, devtools rings) are now documented in the same section.

### Fixed

- **Vite plugin now generates client stubs for `live.lock(...)` and `live.idempotent(...)` exports.** Previously the static-analysis regex only matched `= live(` / `= live.stream(` / `= live.validated(` / `= live.rateLimit(`, so a top-level export like `export const settleInvoice = live.lock(...)` was silently warned as "not wrapped in live()" and produced no client stub. The exports were callable from the server but not from any page that imported them via `$live/<module>`. The plugin now treats `live.lock` and `live.idempotent` exports identically to a plain `live(...)` export: client stub generated, registered in the live registry, type declarations emitted. The runtime side was already correct.

- **Pre-existing crash in the Vite plugin's `configureServer` hook.** A dead `const originalLoad = this.load;` line at `vite.js:785` crashed dev-server boot under newer Vite versions (`Cannot read properties of undefined (reading 'load')`) because `this` is not bound to the plugin in modern Vite. The line was unused and has been removed.

### Internal

- **End-to-end coverage for `live.validated()` and the `presence` / `cursor` merge strategies.** Three new spec files run twice per CI pass (dev + prod): `test/e2e/schema-validation.spec.js` (9 scenarios x 2 = 18 cases) proves that `live.validated(schema, fn)` rejects invalid payloads with `RpcError('VALIDATION', ...)` carrying the structured `issues` array, accepts valid payloads, surfaces deep paths (`user.name`, `items.<index>`) on nested-schema failures, and isolates per-call failures across concurrent contexts. `test/e2e/presence.spec.js` (6 x 2 = 12 cases) proves `merge: 'presence'` join / leave / refreshed events round-trip across multiple connected clients, including late-join initial-fetch hydration and key-stable in-place updates. `test/e2e/cursor.spec.js` (6 x 2 = 12 cases) covers `merge: 'cursor'` update / remove with the same multi-page coverage. Fixture additions: `test/fixture/src/live/{schema,presence,cursor}.js` plus matching pages under `test/fixture/src/routes/`. e2e total goes from 78 to 120 cases per pass.

- **End-to-end test harness mirroring the adapter pattern.** New `test/fixture/` (in-tree minimal SvelteKit app declaring `"svelte-realtime": "file:../.."`) and `test/e2e/` (Playwright config, dev/prod server starters, global setup/teardown). 39 scenarios run twice per CI pass: once against the Vite dev server, once against the built production server (`vite build` + `node build/index.js`). Coverage: 10 queue-replay scenarios (single mutate happy/fail, concurrent A+B failures, A succeeds B fails, A fails B succeeds, server-confirm absorb, server-unrelated interleave, free-form mutate concurrent fail, three concurrent mixed outcomes, drain + post-drain hot path), 2 lock scenarios (FIFO serialization with non-overlap invariant, `maxWaitMs` `LOCK_TIMEOUT`), 3 smoke scenarios (initial fetch, RPC roundtrip, server publish reflected in subscribed UI), 13 multi-page scenarios using parallel `BrowserContext`s to prove cross-connection pubsub fan-out, late-join replay, cross-client optimistic absorb (success and failure paths), cross-client lock contention, and a 10-key stress publish; 4 reconnect scenarios that force a server-initiated WS close mid-mutate and prove the optimistic queue rolls back cleanly + auto-reconnect catches up missed events; and 6 per-user auth scenarios using `BrowserContext.addCookies()` to give each context a distinct fake identity (proves `ctx.user` reaches RPC handlers, per-user stream isolation via dynamic topics keyed on `ctx.user.id`, cross-user routing, and role-gated guards). 78 total test cases per CI pass. Fixture pages expose a `window.__test` API so test scenarios drive the full client-side flow via `page.evaluate` (no `expect.poll` workarounds masking real ordering bugs). New `npm run test:e2e` script. `test-results/` and `playwright-report/` ignored.

- **Property-based test coverage for `store.mutate` queue-replay correctness.** Added `fast-check` as a dev dependency and 4 property tests under `__stream() mutate queue-replay property tests` that drive random sequences of (server-event, mutate-start, mutate-settle) operations against a real stream and compare the final displayed value to a brute-force reference model. The reference is a straight transcription of the design contract in plain JS: server events build a server-state, in-flight mutate-starts open queued entries, mutate-settles either graduate (success + not absorbed) or just remove the entry. Properties run 100 / 60 / 25 / 60 random iterations per `it` block (245 total per test run) covering: final-state matches reference, all-fail leaves only initial + applied server events (no phantoms), absorbed mutate yields the same state as the server event alone, post-drain server events apply via the hot path. No production code change.

### Changed

- **`store.mutate(asyncOp, optimisticChange)` now uses always-on queue replay.** Pending mutations are tracked in an in-flight queue and the displayed value is recomputed by replaying that queue against the un-overlaid server state after every server event and every settle. The public API is unchanged; the win is that concurrent mutates roll back independently. If A and B are both in flight and both fail, the displayed state returns to the latest server state with no phantom traces of either A or B (the prior snapshot/restore approach could leak state between overlapping rollbacks). Server events with a key matching a queue entry's optimistic key absorb the entry, so the typical "client generates UUID, server confirms with same id" flow continues to reconcile without flicker.

  Steady-state hot path is unchanged: when no `mutate` is in flight, the per-event work is identical to before plus a single `_optimisticQueue.length === 0` branch check. Free-form mutator semantics are also unchanged: shallow draft (slice for arrays, object spread otherwise), top-level shape changes participate in replay cleanly, in-place item field mutations are NOT isolated.

### Added

- **Bounded wait for `live.lock` via `maxWaitMs`.** Pass `maxWaitMs` (in the config-object form) to bound how long a queued caller will wait before giving up. On timeout the wrapper rejects with `LiveError('LOCK_TIMEOUT', ...)` so the client receives a typed error with `.code === 'LOCK_TIMEOUT'`, plus `.key` and `.maxWaitMs` fields for observability. The current holder's handler is **not** interrupted; only the waiting caller gives up. Subsequent waiters on the same key are unaffected and continue in their original FIFO position.

  ```js
  export const settleInvoice = live.lock(
    { key: (ctx, id) => `invoice:${id}`, maxWaitMs: 5000 },
    async (ctx, id) => settle(id)
  );
  ```

  The default in-process lock and `createDistributedLock` from the extensions package both honor it; for custom lock implementations, the option is forwarded as the third argument: `lockInst.withLock(key, fn, { maxWaitMs })`. Validation runs at registration: non-numeric, non-finite, or negative values throw with a `[svelte-realtime]`-prefixed error.

### Changed

- **Peer-dep bump: `svelte-adapter-uws` `^0.5.0-next.10`** (was `^0.5.0-next.7`). Required for the new `lock.withLock(key, fn, { maxWaitMs })` primitive consumed by `live.lock`'s `maxWaitMs` option above. The intervening `next.8` and `next.9` releases also ship framework invariant assertions, bounded-by-default capacity caps across adapter core and bundled plugins, and additional chaos scenarios on the test harness; consumers can opt into those independently. Heads-up if you call the adapter's lock plugin directly: `lock.clear()` now rejects pending waiters with a typed `LOCK_CLEARED` error instead of leaving them hanging, so any code that ignored `clear()`-driven rejections needs a `catch`.

- **Default in-process lock backing `live.lock` rewritten as a per-key FIFO waiter queue.** Replaces the prior `Map<string, Promise>` chain so that `maxWaitMs` cancellations can skip cancelled waiters cleanly without breaking FIFO ordering for the rest of the queue. Behavior for existing call sites without `maxWaitMs` is identical: same FIFO, same parallelism across keys, same handler-error propagation that unblocks the next waiter.

### Documentation

- **New "Request correlation" section** documenting how `ctx.requestId` flows from the wire envelope (or `X-Request-ID` header) through `live()` handlers and into the `svelte-adapter-uws-extensions` postgres tasks/jobs APIs. Includes both call shapes (explicit `{ requestId: ctx.requestId }` and the `{ platform: ctx.platform }` auto-extract form), a SQL example showing how to join `ws_tasks` and `ws_jobs` rows back to the originating RPC, and a note about keeping the id out of Prometheus label sets to avoid cardinality blowup.

### Changed

- **`live.push({ userId }, ...)` gains cluster-routing fallback via `live.configurePush({ remoteRegistry })`.** When a `remoteRegistry` is configured (the connection registry from `svelte-adapter-uws-extensions/redis/registry` is the intended consumer), `live.push` falls back to `remoteRegistry.request(userId, event, data, options)` whenever the userId is not registered on the calling instance. The local in-process Map populated by `pushHooks.open` / `pushHooks.close` continues to win when an entry is present, so single-instance setups see no behavior change.

  ```js
  import { live } from 'svelte-realtime/server';
  import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry';

  const registry = createConnectionRegistry(redis, { identify: (ws) => ws.getUserData()?.userId });
  live.configurePush({ remoteRegistry: registry });
  // live.push({ userId: 'u-on-other-server' }, 'event', data) now reaches that user.
  ```

  `live.configurePush` accepts the new field independently of `identify`; both can be set in one call. Errors from the remote registry layer (offline / timeout / handler error) propagate as-is rather than being translated to `LiveError('NOT_FOUND')` so callers can distinguish "no connection anywhere in the cluster" from "connection found but the request failed in transit." Single-instance behavior (no registry configured, unknown userId) still throws `LiveError('NOT_FOUND')`.

- **Transform throws on the publish path now route to per-stream `onError`.** When a `live.stream()` is configured with both `transform` and `onError`, an exception thrown from inside the transform on a `ctx.publish()` call now fires the configured `onError(err, null, topic)` observer (with `null` ctx, since the transform runs in the publish-helper closure rather than a handler context). The publish itself is dropped silently for that frame because the projected wire data is invalid.

  Streams configured with `transform` but no `onError` keep the prior behavior: the throw propagates up out of `ctx.publish()`, surfacing as an `INTERNAL_ERROR` on the originating RPC. Apps that haven't opted into the observer pattern still see failures the way they did before.

  Closes the documented remaining-delta from the per-stream `onError` boundary: loader throws were already routed (initial subscribe, stale-reload, `.load()` SSR), but per-publish transform throws went unobserved. Apps with a `transform` typo or unexpected null-field can now catch the failure once via `onError` instead of cascading into every RPC that touches the topic.

- **`coalesceBy` extractor throws on the publish path now route to per-stream `onError`.** Symmetric closure of the same publish-path observability gap for the other user-supplied function in the closure. When a `live.stream()` is configured with both `coalesceBy` and `onError`, an exception thrown from inside the coalesce-key extractor on a `ctx.publish()` call now fires the configured `onError(err, null, topic)` observer (with `null` ctx, same contract as the transform path). The publish itself is dropped silently for that frame because there is no key to fan out under.

  Streams configured with `coalesceBy` but no `onError` keep the prior behavior: the throw propagates up out of `ctx.publish()`, surfacing as an `INTERNAL_ERROR` on the originating RPC.

  Apps with a `coalesceBy` extractor that may throw on edge-case payloads (null fields, unexpected shapes) can now catch the failure once via `onError` instead of cascading into every RPC that touches the topic.

### Added

- **DevTools per-stream payload preview.** Click any stream row in the dev-mode overlay to expand a list of the 20 most recent pub/sub envelopes (time + event + JSON data). Pretty / Raw toggle controls JSON rendering verbosity (Pretty truncates at ~200 chars, Raw at ~500). Pause stops capture without affecting the live `last:` timestamp; Clear events drops every stream's ring buffer.

  Captured payloads are walked once at write time with key-based redaction. Default redact list: `password`, `token`, `apiKey` / `api_key`, `secret`, `authorization`, `cookie`, `sessionid` / `session_id`, `csrf` / `csrftoken`. Match is case-insensitive and exact-key. Override at runtime:

  ```js
  import { __devtools } from 'svelte-realtime/client';
  if (__devtools) __devtools.redactKeys.add('ssn');
  ```

  Recursion capped at depth 5 (deeper objects show `'[depth-cap]'`); arrays capped at 50 items (overflow shows `'[+N more]'`). Pretty/Raw and Pause states persist across reloads via `localStorage`. Production builds are unaffected: the entire instrumentation is gated behind `import.meta.env.PROD`.

- **Curried form for `rpc.createOptimistic`.** Pass two arguments instead of three (`store, change`) and the call returns a `(...callArgs) => Promise` callable bound to that store + change. Useful when one optimistic-update setup applies to many call sites with different args.

  ```js
  const optimisticSend = sendMessage.createOptimistic(
    messages,
    (current, args) => [...current, { id: tempId(), text: args[0] }]
  );
  await optimisticSend('Hello!');
  await optimisticSend('There!');
  ```

  The three-argument direct form (`rpc.createOptimistic(store, callArgs, change)`) continues to work unchanged. Arity-2 vs arity-3 detection at call site.

- **Stream-side `store.createOptimistic(rpc, callArgs, change)`.** Same flow as `rpc.createOptimistic(store, callArgs, change)`, expressed from the stream's perspective. Identical semantics; pick whichever reads more naturally for the call site.

- **`createTestContext({ user })` builder in `svelte-realtime/test`.** Returns a `ctx`-shaped object suitable for direct unit tests of guards or predicates: `expect(myGuard(createTestContext({ user })))`. Mirrors the production `_buildCtx` shape; helper methods (`publish`, `throttle`, `signal`, `shed`, etc.) are no-ops returning sensible defaults so predicates that read `ctx.user` / `ctx.cursor` work without setup. Reach for `createTestEnv()` only when you need full publish/subscribe round-trips.

- **`stream.simulatePublish(event, data)` on the test stream return.** Discoverable shorthand for `env.platform.publish(stream.topic, event, data)` that lives where tests are already focused. Throws a clear error if called before the stream's topic is known (i.e. before the initial subscribe round-trip lands).

- **Chaos harness on `createTestEnv`.** Pass `chaos: { dropRate, seed }` to drop a configurable fraction of `platform.publish` events at the platform layer; pair with a string `seed` for deterministic, replayable drop sequences. Used to write resilience tests against pub/sub message loss without spinning a real cluster.

  ```js
  import { createTestEnv } from 'svelte-realtime/test';

  const env = createTestEnv({ chaos: { dropRate: 0.5, seed: 'rep-1234' } });
  env.register('chat', chat);
  // ... half of every publish dropped, same sequence across runs.

  // Runtime control:
  env.chaos.set({ dropRate: 1.0 }); // drop everything
  env.chaos.disable();
  env.chaos.dropped; // counter
  env.chaos.resetCounter();
  ```

  Currently models the `drop-outbound` scenario only - pub/sub events to subscribers are dropped. RPC replies (`platform.send`) are exempt because timing them out would just hang test code.

- **`invalidateOn` option on `live.stream()` for topic-driven loader reruns.** Declare a glob-style pattern (or array of patterns) and any `ctx.publish` whose topic matches triggers a rerun of the stream's loader, with the result broadcast as a `refreshed` event so every subscriber gets the new state. Useful for mutations whose effects don't fit the merge-strategy model cleanly (bulk operations, server-side recomputation, cascading writes).

  ```js
  export const todos = live.stream('todos', loadTodos, {
    merge: 'crud',
    invalidateOn: 'todos:*'
  });

  // Anywhere in your live functions:
  ctx.publish('todos:bulk-imported', 'created', { count: 42 });
  // -> matches 'todos:*', the todos loader reruns, the result is broadcast
  //    as a 'refreshed' event, every subscriber gets the new state.
  ```

  `*` is the wildcard (matches any sequence of one or more characters; other regex specials are escaped). Multiple patterns are OR-ed. Reloads dedupe via a per-watcher `reloading` flag, so concurrent triggers while a reload is in flight collapse to one rerun. `refreshed` events are excluded from the invalidation check so a pattern that happens to match its own stream's topic does not loop.

  Reuses the staleness-watchdog machinery for the rerun (captures the first subscriber's `ctx` + args, applies the init `transform` if configured, broadcasts as `refreshed`). Loader throws on the reload path route through the same `onError(err, ctx, topic)` observer as the staleness path.

- **DevTools Streams tab now shows merge strategy, last-event age, and per-stream error state.** The dev-mode overlay panel (toggle with `Ctrl+Shift+L`) gains three new fields per stream entry: `merge` (the configured merge strategy), `last:<event> <age>` (event name and relative age of the most recent pub/sub frame), and `err: <code> - <message>` (when the stream is in the error state, cleared on recovery). Existing fields (path, topic, subscriber count) unchanged. The RPC and Connection tabs are unchanged.

  Production builds are unaffected - the overlay and its instrumentation are stripped via the `import.meta.env.PROD` gate.

- **`rpc.createOptimistic(store, callArgs, optimisticChange)` shorthand on every generated RPC stub.** Sugar for `store.mutate(() => rpc(...callArgs), wrappedChange)` that threads `callArgs` into the optimistic-change callback so call sites don't have to capture them in a closure.

  ```js
  import { sendMessage, messages } from '$live/chat';

  await sendMessage.createOptimistic(
    messages,
    ['Hello!'],
    (current, args) => [...current, { id: tempId(), text: args[0] }]
  );
  ```

  `callArgs` is always an array (single-arg RPCs use `[arg]`). The third argument accepts the same two shapes as `store.mutate()`: a `(current, args) => newValue` function or a `{ event, data }` object. Behavior on success/rollback/server-confirmation is identical to `store.mutate()`; the shorthand is purely syntactic. Reach for `store.mutate()` directly when the asyncOp isn't an RPC (third-party API call, multi-step flow).

- **Build-time `defineTopics` registry check in the Vite plugin.** When the plugin sees a `defineTopics({...})` call anywhere under `src/`, it parses the patterns and validates string-literal topics passed to `live.stream(...)` and `live.channel(...)` against the registry. A literal that does not match any registered pattern triggers a one-shot warning naming the file and the offending topic, suggesting either adding the topic to `defineTopics` or calling `TOPICS.<name>(...)` instead.

  ```
  [svelte-realtime] src/live/feed.js: live.stream topic 'mistyped-topic' is not in
  your TOPICS registry. Either add it to defineTopics({...}) or call TOPICS.<name>(...)
  instead of passing a string literal.
  ```

  Covers static-string patterns and arrow-return template literals; template interpolations are matched as `.+` so any value satisfies the placeholder. Dynamic values (function references, spreads) are silently skipped at parse time. Projects without any `defineTopics` call get no warnings - the check is opt-in via adopting the registry helper.

  Closes the most-common-by-far class of "I changed the SQL trigger but forgot to update the topic string" bugs at build time, without runtime overhead.

- **`expectGuardRejects(promise, expectedCode?)` helper in `svelte-realtime/test`.** Ergonomic wrapper for the common "this call should be denied" assertion: awaits the promise, asserts it rejected with a `LiveError` of the expected code (default `'FORBIDDEN'`), and returns the rejected error so further assertions can run on it.

  ```js
  import { createTestEnv, expectGuardRejects } from 'svelte-realtime/test';

  const env = createTestEnv();
  env.register('admin', adminModule);

  const user = env.connect({ role: 'viewer' });
  await expectGuardRejects(user.call('admin/destroyAll'));
  await expectGuardRejects(env.connect(null).call('admin/destroyAll'), 'UNAUTHENTICATED');

  const err = await expectGuardRejects(user.call('admin/destroyAll'));
  expect(err.message).toMatch(/admin role/);
  ```

  Throws a clear `[svelte-realtime]`-prefixed error if the promise resolves, rejects with a non-`LiveError`, or rejects with a different code. Pairs with the existing `createTestEnv()` harness; no separate setup needed.

- **Dev-mode silent-topic warning via `live.silentTopicWarning()`.** When a stream subscribes to a topic and no events arrive within a configurable window (default 30 seconds), the framework logs a one-shot `console.warn` naming the topic and the common causes - a missing `pg_notify` trigger, a missing handler-side `ctx.publish()`, or an intentionally low-traffic topic the user can suppress. Closes the most-common-by-far class of "the realtime stream isn't updating" debugging sessions.

  ```js
  import { live } from 'svelte-realtime/server';

  // Lower the bar (default 30s)
  live.silentTopicWarning({ thresholdMs: 5000 });

  // Suppress per-topic for known-quiet streams
  live.silentTopicWarning({ suppress: ['admin:audit', 'cron:reports'] });

  // Disable globally
  live.silentTopicWarning(false);
  ```

  Topics starting with `__` (system topics: `__realtime`, `__signal:*`, `__custom`) are skipped automatically; users don't need to populate `suppress` for them. Each topic warns at most once per process; the warning never fires for a topic that has seen at least one event, and re-subscribing after a warn does not re-fire. The watchdog arms on the first subscriber to a topic, observes every publish, and disarms when the last subscriber leaves.

  Hard-gated to `NODE_ENV !== 'production'`: the activation gate is constant-folded by Vite/Rollup so production builds carry zero overhead regardless of configuration. The watchdog state is never touched in production paths.

  Reuses the same lifecycle hook points as the existing staleness watchdog (`staleAfterMs`); apps using both features share the per-topic registry machinery.

- **Svelte 5 store helpers `store.rune()` and `store.map(fn)` on every stream store.** Generated `$live/*` streams now expose a `.rune()` method that returns a Svelte-5 reactive object backed by the stream's value, and a `.map(fn)` method that projects each item of an array stream through `fn` and returns a composable mapped store.

  ```svelte
  <script>
    import { todos } from '$live/todos';

    // Svelte 5: reactive { current } via fromStore
    const items = todos.rune();

    // Per-item projection (works in both Svelte 4 and 5)
    const titles = todos.map(t => t.title);

    // Composes with rune() for Svelte 5 fine-grained reactivity
    const titlesRune = todos.map(t => t.title).rune();
  </script>

  <p>{items.current?.length ?? 0} items</p>
  {#each $titles as title}<li>{title}</li>{/each}
  ```

  `rune()` calls `fromStore` from `svelte/store` under the hood; reading `current` inside an effect or component subscribes via Svelte's `createSubscriber` for fine-grained reactivity, and reading it outside an effect synchronously returns the latest value. Throws under Svelte 4 (where `fromStore` is not exported) so apps still on Svelte 4 see a clear error instead of silent confusion - they should keep using the existing `Readable<T>` interface via `$store` auto-subscribe.

  `.map(fn)` returns an object with the same `{ subscribe, rune, map }` shape as the source, so it composes with `$`-prefix auto-subscription (`$mapped`), with `.rune()` for Svelte 5 fine-grained reactivity, and chains via further `.map()` calls. Semantics match the documented `($stream ?? []).map(fn)` pattern: a `null` or `undefined` source emits `[]`, an array source emits `source.map(fn)`, and a non-array source (set-merge stream, paginated wrapper) emits `[]` after a dev-mode `console.warn`. Subscriptions are lazy: the source is only subscribed while at least one mapped consumer is active. Sidesteps the `$derived(() => ...)` footgun where storing a function reference instead of its return value silently breaks rendering.

  No new exports beyond the methods on the stream store. The existing `subscribe` interface is unchanged; apps that don't call `.rune()` or `.map()` see no behavior change.

### Changed

- **Editing a `src/live/*.js` file now triggers an HMR update instead of a full page reload.** The Vite plugin's generated client stubs (the virtual `$live/*` modules) now emit `if (import.meta.hot) import.meta.hot.accept();`, which lets Vite re-execute the stub in place when the source file changes. The server-side handler reload was already wired (the registry virtual module reloads via `_hmrReloadRegistry`); the client-side accept directive was the missing piece that made Vite fall back to a full page reload.

  Wire from any consumer that already had HMR working (Svelte components, `+page.server.js` files): editing a handler updates without losing scroll position, form state, or open subscriptions. Pure addition to the generated stub output. Production builds dead-strip the `if (import.meta.hot)` block.

  No API change; no per-app wiring needed. Apps that import from `$live/...` automatically benefit.

- **Multi-stream page mounts now batch their wire-level subscribes into one frame.** When several streams subscribe in the same microtask (the typical multi-widget page mount), the underlying WebSocket subscribe frames now collapse into one `subscribe-batch` frame instead of N individual `subscribe` frames. Apps that wired their auth check via `hooks.ws.js`'s `subscribeBatch` export now see one auth call covering every topic on the page, instead of N per-topic `subscribe` calls.

  Wire-frame count for a 5-stream page mount drops from 6 (one batched RPC envelope plus 5 subscribe frames) to 2 (one batched RPC envelope plus one `subscribe-batch` frame). On reconnect the same shape was already emitted; this closes the gap on initial mount.

  Transparent improvement - no realtime API change. Apps automatically benefit when the adapter peer is on `^0.5.0-next.7` (the new floor). Apps that haven't wired `subscribeBatch` server-side still get the wire-frame reduction; the user's per-topic `subscribe` hook continues to work via the adapter's per-topic fallback.

### Added

- **Stream staleness watchdog and per-stream `onError` boundary on `live.stream()`.** Two new `StreamOptions` fields for streams whose underlying source can quietly stop emitting (CDC drops, polling stalls, upstream cache evicts the key) or whose loader can fail mid-flight (database timeouts, transient backend errors).

  ```js
  // src/live/dashboard.js
  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    async (ctx, orgId) => loadAudit(orgId),
    {
      merge: 'crud',
      key: 'id',
      staleAfterMs: 30_000,
      onError: (err, ctx, topic) => log.warn({ err, topic }, 'audit stream error')
    }
  );
  ```

  `staleAfterMs` arms a per-topic watchdog on the first subscribe. Every `ctx.publish` to the topic resets the timer; if no events arrive for the configured duration, the realtime layer re-runs the stream's loader and broadcasts the result as a `refreshed` event. The client merges `refreshed` as a full-state replacement across every merge strategy: `crud` swaps the array and rebuilds its key index, `set` replaces the value, `latest` swaps the buffer, `presence` and `cursor` swap and rebuild indexes. Optimistic-key tracking from `store.optimistic()` / `store.mutate()` is cleared on receive (the server's snapshot is authoritative).

  Watchdog state is per-topic, not per-subscriber. Multiple subscribers to the same topic share one timer; the timer arms on the first subscribe and clears when the last subscriber leaves. The reload uses the first subscriber's `ctx` and `args`, which is correct for shared topics since the loader's output is identical regardless of which subscriber's ctx triggers it.

  `onError(err, ctx, topic)` is an observer-only hook: it fires when the loader throws on the initial subscribe path, on the staleness-driven reload, or on the `.load()` SSR path. Errors thrown inside `onError` are silently swallowed so a buggy logger never breaks the original error path. The original error continues to propagate to the caller (or, on stale-reload, drives the timer re-arm). Sibling to the global `onError` setter from `svelte-realtime/server` - per-stream observers fire alongside the global one, not instead of it.

  Apps that want a topic-scoped degraded signal can publish a system event from inside the handler:

  ```js
  onError: (err, ctx, topic) => {
    ctx.publish(`__system:${topic}`, 'degraded', { reason: err.message });
  }
  ```

  Both options are independent: a stream can declare `staleAfterMs` without `onError`, or vice versa. Apps that don't use either pay zero overhead - the publish-helper's watchdog reset is gated behind a Map size check, and the loader try/catch only inspects `__streamOnError` when set.

  Validation runs at registration: `staleAfterMs` must be a positive finite number; `onError` must be a function. Misconfiguration fails fast at app boot with a `[svelte-realtime]`-prefixed error.

- **Server-initiated push via `live.push()` and client-side `onPush()`.** New primitive on the `live` function namespace for sending a request to a connected user and awaiting their reply. Routes through a per-instance userId -> WebSocket registry maintained by a small pair of hooks.

  ```js
  // hooks.ws.js - wire the registry once
  import { pushHooks } from 'svelte-realtime/server';
  export const open = pushHooks.open;
  export const close = pushHooks.close;
  ```

  ```js
  // anywhere on the server (admin RPC, cron, webhook receiver, etc.)
  import { live } from 'svelte-realtime/server';

  const reply = await live.push(
    { userId: 'u-123' },
    'confirm-delete',
    { itemId: 42 },
    { timeoutMs: 30_000 }
  );
  if (reply.confirmed) await actuallyDelete(42);
  ```

  ```svelte
  <script>
    import { onPush } from 'svelte-realtime/client';

    onPush('confirm-delete', async ({ itemId }) => {
      return { confirmed: confirm(`Delete item ${itemId}?`) };
    });
  </script>
  ```

  Default identifier reads `ws.getUserData()?.user_id ?? ws.getUserData()?.userId`. Override with `live.configurePush({ identify: (ws) => ... })` for custom userData shapes; pass `null` to restore the default. Anonymous connections (identify returning null/undefined) are silently skipped at registration so they cannot be push targets.

  Returns whatever the client's `onPush` handler returns. Throws `LiveError('NOT_FOUND')` if no connection is registered for the userId. Propagates `Error('request timed out')` from the underlying platform primitive on the configurable `timeoutMs` (default 5000ms), and `Error('connection closed')` if the WebSocket closes before reply.

  Multi-device users see most-recent-connection-wins routing: a second connection by the same user replaces the first as the push target; older connections still receive topic publishes via their own subscriptions, only push routing flips. The reverse index handles fast device-swap sequences correctly so `close` on a stale ws does not deregister the active connection.

  Client-side `onPush(event, handler)` multiplexes multiple events over the adapter's single `onRequest` channel, so apps install one handler per event without overwriting each other. Returns an unsubscribe function. Throwing from a handler rejects the server-side promise.

  Single-instance routing only in this slice: a user's connection must live on the same server process that calls `live.push`. Cluster-wide push (any instance routing to any user's WebSocket) requires the connection-registry primitive in the extensions package.

  Requires `svelte-adapter-uws@^0.5.0-next.4` for the underlying `platform.request` and `onRequest` primitives.

- **`realtimeTransport()` SvelteKit transport hook preset.** New `svelte-realtime/hooks` entry point. Auto-registers serialization for `RpcError` and `LiveError` across the SSR / client boundary so typed errors thrown during `+page.server.js` `load()` arrive at `+error.svelte` (and any client-side handler that rethrows them) preserved as the original class with `code` intact, rather than as plain `Error` instances.

  ```js
  // src/hooks.js
  import { realtimeTransport } from 'svelte-realtime/hooks';

  export const transport = realtimeTransport();
  ```

  Compose with app-defined types (user entries win on key conflict):

  ```js
  // src/hooks.js
  import { realtimeTransport } from 'svelte-realtime/hooks';
  import { Vector } from '$lib/geometry';

  export const transport = realtimeTransport({
    Vector: {
      encode: (v) => v instanceof Vector && [v.x, v.y],
      decode: ([x, y]) => new Vector(x, y)
    }
  });
  ```

  Wire from `src/hooks.js` (the shared hook), NOT `hooks.server.js`. SvelteKit's transport primitive needs both encode (server-side) and decode (client-side hydration) visible at build time. `RpcError`'s optional `issues` field (carried by `live.validated()` failures) survives the round-trip. Validation runs at registration: malformed extras (missing or non-function `encode`/`decode`) throw immediately so misconfiguration fails fast at app boot.

- **`fallback` + `onError` options on `.load()` for partial SSR degradation.** When you wire many streams into a `+page.server.js` `load()`, a single failing loader currently throws and SvelteKit shows the error page, taking down every other stream on the page. The new opt-in options let one failure render an empty placeholder while the rest of the page loads:

  ```js
  // +page.server.js
  import { auditFeed, presence, reactions } from '$live/dashboard';

  export async function load({ locals, platform }) {
    const [audit, presenceData, reacts] = await Promise.all([
      auditFeed.load(platform, {
        user: locals.user,
        args: [locals.user.organization_id],
        fallback: [],
        onError: (err) => locals.log.error({ err }, 'audit feed SSR failed')
      }),
      presence.load(platform, { user: locals.user, fallback: {} }),
      reactions.load(platform, { user: locals.user, fallback: [] })
    ]);
    return { audit, presenceData, reacts };
  }
  ```

  The client hydrates the fallback value for the failing stream; the WebSocket subscribe attempts the load again on connect once the page is interactive, so the user sees a placeholder during SSR and the live stream once the connection comes up.

  Opt-in via the PRESENCE of the `fallback` key - the value itself can be anything (empty array, sentinel object, even `null` or `undefined`). Without `fallback`, errors propagate as before (back-compat). `onError` is optional; observer hooks throwing are silently swallowed so a buggy logger never breaks SSR. Errors caught: loader throws, validation, guard, access filter, missing handler. `null` returns from gated streams (`live.gate`) pass through unchanged - the gate's "no data" decision is not treated as an error.

- **`health` store on the client for system-wide degraded / recovered detection.** A new top-level Readable from `svelte-realtime/client` reflects the realtime system's health, sourced from `degraded` / `recovered` events on the `__realtime` topic. Apps can render a "real-time updates paused, reconnecting..." banner when the upstream pub/sub bus's circuit breaker trips, without wiring the system topic by hand:

  ```svelte
  <script>
    import { health } from 'svelte-realtime/client';
  </script>

  {#if $health === 'degraded'}
    <Banner severity="warn">Real-time updates paused, reconnecting...</Banner>
  {/if}
  ```

  Initial value is `'healthy'`. Flips to `'degraded'` on a server-published `degraded` event, back to `'healthy'` on `recovered`. Subscription is lazy: the realtime client only subscribes to `__realtime` once a consumer first reads the store. Apps that never use `health` pay no cost for the subscription.

  The store deliberately exposes only the state, not the underlying payload. Apps that need richer detail (reason strings, timestamps, etc.) can listen to the topic directly via `import { on } from 'svelte-adapter-uws/client'; on('__realtime').subscribe(...)`. Server-side wiring lives outside this package - the extensions package's pub/sub bus publishes the events when its circuit breaker changes state; this is the consumer side.

- **`store.mutate(asyncOp, optimisticChange)` for optimistic mutations with auto-rollback.** Wraps the existing per-stream `optimistic()` pattern with the missing async pairing: applies a local change synchronously, awaits the async operation, leaves the store as-is on success (server's confirming event reconciles), rolls back on failure. The asyncOp's result becomes the method's return value.

  ```js
  // Event-based: server's confirming `created` event replaces the placeholder.
  const todo = await todos.mutate(
    () => createTodo({ title: 'Buy milk' }),
    { event: 'created', data: { id: tempId(), title: 'Buy milk' } }
  );

  // Free-form mutator: bypass the merge strategy for arbitrary local changes.
  await todos.mutate(
    () => removeTodo('foo'),
    (current) => current.filter(t => t.id !== 'foo')
  );
  ```

  Two patterns for the optimistic change argument:

  - **`{ event, data }`** uses the stream's merge strategy (`crud` / `set` / `latest` / `presence` / `cursor`) - same path as the existing `store.optimistic(event, data)` returning a manual rollback. The typical client-generated-UUID pattern with crud merge composes naturally: the server's confirming `created` event replaces the placeholder via key match, leaving the store with the real server-assigned record.
  - **`(current) => newValue`** runs a free-form mutator on a copy of the current value. Return the new value, OR mutate in place and return undefined (both styles work). Useful for changes that don't fit a single merge event (filters, multi-item rearrangements, complex updates).

  The existing `store.optimistic(event, data)` returning a manual rollback is unchanged. `mutate()` is a higher-level wrapper for the common "RPC + matching local update + auto-rollback on failure" pattern.

  Replay-safety caveat: snapshot/restore. Concurrent optimistic mutations or interleaved server events on the same stream can lose state on rollback. Snapshot is shallow (slice for arrays); top-level shape changes (push, pop, filter, splice) are rolled back cleanly, in-place mutations of individual item fields are NOT (the snapshot and draft share item references). Replace whole items rather than mutating fields: `draft[i] = { ...draft[i], name: 'x' }`.

- **`defineTopics(map)` helper for centralizing topic patterns.** A small registry helper so stream definitions and any out-of-band consumers (SQL triggers, Postgres NOTIFY shapes, doc generators, devtools panels) reference one source of truth instead of scattering string literals across the codebase.

  ```js
  // src/lib/topics.js
  import { defineTopics } from 'svelte-realtime/server';

  export const TOPICS = defineTopics({
    audit:    (orgId)       => `audit:${orgId}`,
    security: (orgId)       => `security:${orgId}`,
    feed:     (orgId, kind) => `feed:${orgId}:${kind}`,
    systemNotices: 'system:notices'
  });
  ```

  Stream definitions reference the registry directly:

  ```js
  import { TOPICS } from '$lib/topics';
  import { live } from 'svelte-realtime/server';

  export const auditFeed = live.stream(
    (ctx, orgId) => TOPICS.audit(orgId),
    loadAudit
  );
  ```

  Returned object exposes the same entries the input did, plus two non-enumerable metadata properties for tooling and docs:

  - `__patterns` - `name -> pattern string` map derived by calling each function with sentinel placeholders matching its arity (`{arg0}`, `{arg1}`, ...). Useful for generating SQL trigger comments or doc-site cross-references that won't drift from the live registry.
  - `__definedTopics: true` - runtime marker tools can use to detect a topic registry.

  Validation runs at registration: empty entries, non-string-non-function entries, or use of reserved names (`__patterns`, `__definedTopics`) throws immediately so misconfiguration fails fast at app boot.

  Doesn't solve the SQL/TypeScript boundary by itself, but makes mismatches greppable (one canonical reference per topic name) and registry-checkable (tooling can compare `TOPICS.__patterns` against the actual SQL or NOTIFY shapes).

- **`onUnsubscribe(ctx, topic, remainingSubscribers)` - third argument exposes the remaining subscriber count.** When the last consumer of a stream leaves, the hook can now tear down the upstream feed without app-side bookkeeping. Backwards-compatible: existing handlers ignoring the extra argument keep working unchanged.

  ```js
  export const orderFeed = live.stream(
    (ctx, orgId) => `orders:${orgId}`,
    loadOrders,
    {
      onSubscribe: (ctx, topic) => upstream.subscribe(topic),
      onUnsubscribe: (ctx, topic, remaining) => {
        if (remaining === 0) upstream.unsubscribe(topic);
      }
    }
  );
  ```

  `remainingSubscribers` is the count of OTHER WebSockets still holding a realtime-stream subscription to the topic after the current one drops. The hook fires once per logical subscription on the dropping connection (mirroring `onSubscribe` firings); every firing for one drain sees the same `remainingSubscribers` value, so the `=== 0` check inside the hook is meaningful regardless of how many logical subs the dropping ws had.

  Replaces the common app-side pattern of "maintain my own per-topic ws set" - the realtime layer was already tracking exactly this information for its own bookkeeping.

- **`quiescent` store on the client for "all streams settled" detection.** A new top-level Readable from `svelte-realtime/client` emits `true` when every active stream has finished loading (or errored) and `false` while at least one is fetching or recovering. Drop a single page-level loading state at the moment all streams settle, instead of flickering one spinner per stream:

  ```svelte
  <script>
    import { quiescent } from 'svelte-realtime/client';
    import { auditFeed, presence, reactions } from '$live/dashboard';
    const a = auditFeed.subscribe(/* ... */);
    const p = presence.subscribe(/* ... */);
    const r = reactions.subscribe(/* ... */);
  </script>

  {#if !$quiescent}
    <Spinner />
  {:else}
    <Dashboard />
  {/if}
  ```

  The same signal also detects "all streams have caught up after a reconnect" - watch for a `false -> true` transition while the adapter's connection status is `'open'`. Pair with the `failure` store and the adapter's `status` store to render a complete connection state per page.

  Streams contribute to the in-flight count from their first subscriber until they reach `'connected'` or `'error'`. A stream defined but never subscribed does not count. Initial value is `true` (no streams yet).

- **`live.lock(keyOrConfig, fn)` for per-key serialization.** Wraps an RPC handler so concurrent calls that resolve to the same lock key run one at a time in FIFO order; calls on different keys run in parallel. Same composable shape as `live.validated` / `live.idempotent` / `live.rateLimit`.

  ```js
  // Per-org leaderboard recompute: only one in-flight recompute per org
  export const recomputeLeaderboard = live.lock(
    (ctx) => `leaderboard:${ctx.user.organization_id}`,
    async (ctx) => {
      const rows = await db.expensive.recompute(ctx.user.organization_id);
      ctx.publish(`org:${ctx.user.organization_id}:leaderboard`, 'set', rows);
      return rows;
    }
  );

  // Static key (single global section)
  export const rebuildSearchIndex = live.lock(
    'search-index-rebuild',
    async (ctx) => { /* ... */ }
  );

  // Custom lock implementation (multi-instance via Redis, etc.)
  // Any object exposing withLock(key, fn) works.
  export const settleInvoice = live.lock(
    { key: (ctx, id) => `invoice:${id}`, lock: customLock },
    live.validated(InvoiceIdSchema, async (ctx, id) => settle(id))
  );
  ```

  Use for cron-ish triggers, expensive recompute, single-flight cache fills, and atomic read-modify-write on shared records.

  Key resolver returning `null`, `undefined`, or `''` bypasses the lock entirely for that call (the handler runs unguarded). Handler errors propagate to the caller and do NOT block subsequent waiters. Composes with the rest of the `live.*` wrapper family.

  Default lock is in-process. For multi-instance deployments, pass any object exposing `withLock(key, fn)` matching the contract via `{ lock }`.

- **Typed subscribe-denial codes on stream `error` stores.** When the server's `subscribe` hook denies a stream subscription, the denial reason now arrives on the stream's existing `error` store as a typed `RpcError` whose `code` is the canonical denial code. Apps can render targeted UI per cause instead of decoding a generic `INTERNAL_ERROR`:

  ```svelte
  <script>
    import { auditFeed } from '$live/audit';
    const err = auditFeed.error;
  </script>

  {#if $err?.code === 'UNAUTHENTICATED'}
    <p>Please sign in to view audit history.</p>
  {:else if $err?.code === 'FORBIDDEN'}
    <p>You don't have access to this organization's audit log.</p>
  {:else if $err?.code === 'RATE_LIMITED'}
    <p>Too many requests. Please wait a moment.</p>
  {:else if $err?.code === 'INVALID_TOPIC'}
    <p>Invalid feed identifier.</p>
  {:else if $err}
    <p>Audit feed unavailable: {$err.message}</p>
  {/if}
  ```

  Canonical codes: `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_TOPIC`, `RATE_LIMITED`. Custom strings the server's `subscribe` hook returns are passed through verbatim as `code` (e.g. `KYC_PENDING`, `PLAN_LOCKED`), so apps can switch on app-specific reasons too. The denial routes via the adapter's `denials` Readable; `stream.error` is the existing `RpcError | null` store, no new public API.

  Same denial naturally fans out to every stream subscribed to the same topic. Stream lifecycle handles the listener wiring: registers on first successful stream RPC (when the topic is known), deregisters on `cleanup()` so HMR / unsubscribe / re-subscribe behave predictably.

- **Dev-mode publish-rate warning.** When a topic crosses 200 events/sec (default, configurable), a one-shot `console.warn` fires pointing at the two natural mitigations:

  ```
  [svelte-realtime] Topic 'cursor:42' is publishing 800 events/sec.
    For high-frequency streams, consider one of:
      live.stream(topic, loader, { coalesceBy: (data) => data.userId })  // latest-value-wins, queued per subscriber
      live.stream(topic, loader, { volatile: true })                     // drop on backpressure, best-effort
    See: https://svti.me/highfreq
  ```

  The two strategies have different intents: `coalesceBy` keeps the latest value per key and replaces the pending value on each new publish (best for cursors, prices, presence - you want the latest value to land); `volatile: true` drops on backpressure with no buffering (best for typing indicators, telemetry pings - a missed frame is gone for good). Pick the one that matches the topic's intent.

  Topics already configured with EITHER `coalesceBy` or `volatile: true` are silently skipped - the user has already chosen their tool, no need to nag. The warning surfaces a real optimization apps miss because they don't know it exists. It runs only in development builds (hard-gated to `NODE_ENV !== 'production'`); production has zero cost. One warning per topic per process so the output never gets noisy. The sampler reads `platform.pressure.topPublishers` which the adapter is already maintaining, so the only added cost in development is one `setInterval` per platform with no per-publish overhead.

  Configurable via `live.publishRateWarning(...)`:

  ```js
  // hooks.ws.js or a startup module

  // Disable entirely (CLI tooling, noisy environments)
  live.publishRateWarning(false);

  // Lower the bar for noisier insight
  live.publishRateWarning({ threshold: 50 });

  // Sample more frequently than the 5s default
  live.publishRateWarning({ threshold: 200, intervalMs: 1000 });
  ```

  Validation runs at registration: invalid `threshold` / `intervalMs` (non-positive, non-finite, wrong type) throws immediately so misconfiguration fails fast.

- **`failure` store on the client for typed reconnect-failure UI.** A new top-level export from `svelte-realtime/client` carries the cause of the most recent non-open connection-status transition, so apps can render targeted UI per failure class instead of decoding close codes themselves.

  ```svelte
  <script>
    import { failure } from 'svelte-realtime/client';
    import { status } from 'svelte-adapter-uws/client';
  </script>

  {#if $failure?.class === 'TERMINAL'}
    <p class="error">Session expired. <a href="/login">Sign in again</a></p>
  {:else if $failure?.class === 'EXHAUSTED'}
    <button onclick={() => location.reload()}>Reconnect</button>
  {:else if $failure?.class === 'THROTTLE'}
    <p class="warn">Server is busy, retrying shortly...</p>
  {:else if $failure?.class === 'AUTH'}
    <p class="error">Could not authenticate (HTTP {$failure.status})</p>
  {:else if $status === 'disconnected'}
    <span>Reconnecting...</span>
  {/if}
  ```

  Discriminated union on `kind`:

  - `{ kind: 'ws-close', class: 'TERMINAL' | 'EXHAUSTED' | 'THROTTLE' | 'RETRY', code, reason }` for WebSocket closes.
  - `{ kind: 'auth-preflight', class: 'AUTH', status, reason }` for `configure({ auth: true })` preflight failures. HTTP `status` (not `code`) so `4401` close vs `401` preflight cannot be confused.

  Five classes:

  - `TERMINAL` - server permanently rejected the client (1008 / 4401 / 4403). Retry loop stopped.
  - `EXHAUSTED` - `maxReconnectAttempts` hit; the network never recovered.
  - `THROTTLE` - server signalled rate-limiting (4429). Reconnect still scheduled, jumped ahead in the backoff curve.
  - `RETRY` - normal transient drop (1006 abnormal, network blip, server restart). Reconnect in progress.
  - `AUTH` - `configure({ auth: true })` HTTP preflight failed before the WebSocket was opened. 4xx is terminal; 5xx and network errors retry.

  Lifecycle: `null` while connected (or before any failure), set on the failing transition, cleared on the next successful `'open'`. NOT set on intentional `close()` - the deliberate-end state is `failure === null` paired with the underlying `status === 'failed'`. Types `Failure` and `FailureClass` are exported alongside.

  Requires `svelte-adapter-uws@^0.5.0-next.5` (peer floor bumped from `next.4`); the store is a one-line re-export of the adapter's `failure` primitive with no transformation.

- **`ctx.requestId` for correlation logging.** The adapter assigns a correlation id per WebSocket connection (stable across every event on that connection) and per HTTP request, honoring an inbound `X-Request-ID` when present. Surfaced on `LiveContext` and `CronContext` so handlers can structured-log the same id from every step of one user's interaction without piping it through their handler signatures.

  ```js
  export default live(async (ctx, input) => {
    log.info({ requestId: ctx.requestId, userId: ctx.user?.id }, 'order received');
    const order = await db.orders.create(input);
    return order;
  });
  ```

  Requires `svelte-adapter-uws@^0.5.0-next.4` (already the peer floor) for the underlying `platform.requestId`. Platforms that don't set it leave `ctx.requestId` as `undefined`.

- **`volatile: true` option on `live.stream()` for fire-and-forget streams.** Marks a stream as intentionally drop-on-backpressure - typing indicators, cursor positions, telemetry pings, anything where a missed frame is gone for good. Two effects:

  - Disables per-event seq stamping for the topic (passes `seq: false` through to the adapter). A reconnect carrying `lastSeenSeq` won't try to backfill the gaps, which is the correct semantic for these stream shapes.
  - Declares intent so the option's presence makes the stream's volatility self-documenting at the call site.

  ```js
  export const cursors = live.stream(
    (ctx, roomId) => `room:${roomId}:cursors`,
    async () => loadInitialCursors(),
    { merge: 'cursor', volatile: true }
  );

  // Per-call form (e.g. inside an RPC handler that fires telemetry pings):
  ctx.publish('telemetry/ping', 'tick', { ts: Date.now() }, { volatile: true });
  ```

  Wire-level "drop on backpressure" is the adapter's default behavior across `platform.publish`, `platform.publishBatched`, and `platform.send` - uWS auto-skips any subscriber whose outbound buffer is over `maxBackpressure` (default 64 KB), per-connection, while non-backpressured subscribers still receive the frame. So `volatile: true` is mostly an intent-declaration + seq-stamping decision on this side; the actual frame-drop happens automatically below us.

  Cannot combine with `coalesceBy` (latest-value-wins requires a queue; volatile drops on backpressure - different intents) or `replay` (volatile messages aren't buffered for resume). Both combinations throw at registration with a guiding error message.

- **Dev-mode shape check on `.hydrate()`.** When `.hydrate()` is called with a value that doesn't match the stream's merge strategy (`crud` / `latest` / `presence` / `cursor` expect arrays; `set` accepts anything), a one-shot `console.warn` fires with the stream path, the configured merge strategy, and the actual type that was passed. Caught early, the fix is usually a missing `.data` unwrap on a paginated SSR response or a typo in the merge option. Stripped from production builds via the existing `process.env.NODE_ENV` gate. `null` and `undefined` are treated as "no data yet" and never warn.

- **`live.rateLimits({ default, overrides, exempt })` for registry-level RPC rate limiting.** Configure rate limits centrally instead of wrapping every handler with `live.rateLimit(...)`. The default rule applies to every RPC path that doesn't have its own per-handler wrapping; per-path overrides tighten or loosen specific paths; `exempt` opts paths out entirely.

  ```js
  // hooks.ws.js or a startup module
  live.rateLimits({
    default: { points: 200, window: 10_000 },
    overrides: {
      'chat/sendMessage': { points: 50, window: 10_000 },
      'orders/create':    { points: 5,  window: 60_000 }
    },
    exempt: ['presence/moveCursor', 'cursor/move']
  });
  ```

  Resolution order per call: `exempt` -> per-handler `live.rateLimit(...)` wrapping (explicit wins over central) -> `overrides[path]` -> `default` -> none. Per-path buckets are keyed by `(path, ctx.user.id)` and use the same sliding-window logic as the existing `live.rateLimit` decorator - both share one bucket map and one sweep timer. Rejected calls return `{ ok: false, code: 'RATE_LIMITED', retryAfter }` matching the existing wrapper's failure shape.

  Stream subscribes are not rate-limited by this primitive (subscribe-rate shaping is the adapter's concern). Pass `null` to clear the registry. Validation runs at registration: invalid `points` / `window` / unknown shape throws immediately so misconfiguration shows up at boot rather than mid-traffic.

- **Automatic wire-level publish batching.** Every `ctx.publish()` made within one microtask now flushes as a single batched WebSocket frame to each subscriber, instead of one frame per call. A handler that publishes 50 items in a `for` loop produces ONE outbound frame per subscriber, not 50. No code change required - handlers keep using `ctx.publish` exactly as before. Subscribers that don't advertise the `'batch'` capability fall back to per-event delivery automatically.

  ```js
  // Bulk import: 50 ctx.publish calls => 1 frame per subscriber
  export const importItems = live(async (ctx, items) => {
    const created = await db.bulkInsert('items', items);
    for (const row of created) {
      ctx.publish(`org:${ctx.user.organization_id}:items`, 'created', row);
    }
  });
  ```

  Behavior preserved across the existing per-topic features:

  - Streams configured with `coalesceBy` continue to use `platform.sendCoalesced` per-subscriber (latest-value-wins replacement). Those publishes do not enter the batched path - the two primitives produce different wire shapes intentionally.
  - Streams configured with `transform` apply the projection BEFORE queuing into the batch. Subscribers see the projected wire data; `coalesceBy` extractors still see the original.
  - `ctx.batch([msgs])` (the documented 0.4.0 list form) is unchanged.
  - `ctx.throttle`, `ctx.debounce`, and `ctx.signal` retain their own scheduling and are not auto-batched.

  Each `await` boundary inside a handler crosses a microtask, so publishes interleaved with awaits flush in their natural order rather than being held until handler exit - the timing semantics every existing handler depends on still hold. Requires `svelte-adapter-uws@^0.5.0-next.4` for the underlying `platform.publishBatched` primitive; older adapters fall back transparently to per-event publishes.

- **Org/user-scoped access predicates + `guard({ authenticated })` + `live.scoped()`.** Four small pieces that close the most common authorization-bypass holes without per-handler boilerplate or magic auto-detection.

  ```js
  // Module-level auth declarative shorthand
  export const _guard = guard({ authenticated: true });

  // Stream: subscriber's org must match the topic arg
  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    loader,
    { access: live.access.org() }
  );

  // RPC: the input's orgId must match the caller's org
  export const updateOrg = live.scoped(
    live.access.org({ from: (ctx, input) => input.orgId }),
    live.validated(schema, async (ctx, input) => updateOrg(input))
  );

  // Compose multiple predicates (e.g. own-user OR admin)
  const isAdmin = (ctx) => ctx.user?.role === 'admin';
  export const adminOrSelfFeed = live.stream(
    (ctx, userId) => `notes:${userId}`,
    loader,
    { access: live.access.any(isAdmin, live.access.user()) }
  );
  ```

  - **`guard({ authenticated: true })`** - declarative shorthand. Throws `UNAUTHENTICATED` when `ctx.user` is null. Composes with function-style middleware via `guard(...)`'s variadic args: `guard({ authenticated: true }, customCheck)`.
  - **`live.access.org(opts?)`** - predicate returning `true` when an extracted value (default arg 0) equals `ctx.user.organization_id` (default field). Returns `false` for null users (anonymous never passes). Configurable via `from` and `orgField`.
  - **`live.access.user(opts?)`** - predicate returning `true` when an extracted value (default arg 0) equals `ctx.user.user_id` (default field, matching `[table]_id` convention). Configurable via `from` and `userField`.
  - **`live.scoped(predicate, fn)`** - wraps an RPC handler with a predicate. Throws `UNAUTHENTICATED` (no user) or `FORBIDDEN` (user present) when the predicate returns false. Async predicates are awaited. Composes with `live.validated`, `live.rateLimit`, etc. Streams use the `access` option instead.
  - **Stream `access` predicates now receive args.** `access(ctx, ...args)` lets the new args-aware helpers fire on the right value. Existing predicates that take only `ctx` are unaffected (extra args ignored).
  - **`live.access.any` / `.all` forward args** so `org()` and `user()` predicates compose. Existing call sites are unchanged.

  Defaults follow the SQL `[table]_id` convention (`user_id`, `organization_id`). Override per-helper if your data shape differs (e.g. `live.access.org({ orgField: 'tenant_id' })`).

- **`transform` option on `live.stream()` for server-side projection.** Define the wire shape once; the framework applies it to BOTH the initial loader result AND every subsequent live publish for that topic. Typical 80-90% payload reduction on data-heavy streams (audit logs, dashboards, anything where the database row has 30 columns and the client needs 4).

  ```js
  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    async (ctx, orgId) => db.auditRows.recent(orgId, 50),
    {
      merge: 'crud', key: 'id',
      transform: (row) => ({
        id: row.record_id,
        op: row.operation,
        at: row.changed_at
      })
    }
  );
  ```

  Applied per-item for array results (covers `crud` / `latest` / `presence` / `cursor` merge) and to the whole value for non-arrays (covers `set` merge). Paginated loader responses (`{ data, hasMore, cursor }`) transform `.data` only. Composes with `coalesceBy` (the key extractor sees ORIGINAL pre-transform data; subscribers see the transformed wire shape). Streams without `transform` are unaffected. Works through `.load()` for SSR. The transform must be synchronous.

  Implementation note: pre-subscribe publishes for a topic go through raw (the per-topic transform registry is populated when the first subscriber arrives). For typical app patterns this is invisible since publishes follow subscribes.

- **`args` schema option on `live.stream()`.** Validates the stream's argument tuple at subscribe time, BEFORE the topic function runs - prevents topic injection via malformed dynamic-topic args. Accepts any Standard Schema-compatible schema (Zod, ArkType, Valibot v1+, etc.); the schema validates the whole args tuple, so use `z.tuple([...])` or the equivalent.

  ```js
  import { z } from 'zod';

  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    async (ctx, orgId) => loadFeed(orgId),
    { args: z.tuple([z.string().uuid()]) }
  );
  ```

  Validation failures reject the subscribe with code `VALIDATION` and a populated `issues` array, matching the existing `live.validated()` shape. Validated/coerced args reach the topic function and the loader, so Zod transforms (e.g. `z.string().toLowerCase()`) apply downstream. Streams without `args` are unaffected - back-compat preserved. Works through `.load()` for SSR too.

- **Per-RPC `timeout` override via `.with({ timeout })`.** Long-running queries no longer have to share the global 30s timeout. Pass a per-call override to wait longer:

  ```js
  // Wait up to 2 minutes for this report
  const report = await generateReport.with({ timeout: 120_000 })(params);

  // Composes with idempotency
  await charge.with({ idempotencyKey: 'k1', timeout: 90_000 })(payload);
  ```

  Resolution order: per-call `timeout` > global `configure({ timeout })` > 30s default. Timeout-only `.with()` calls do NOT dedup against the base path within a microtask - the longer-waiting caller would otherwise be rejected at the shorter call's timeout. Idempotency dedup still applies when `idempotencyKey` is set. Per-call `timeout` is ignored inside `batch(fn)` (the batch-level timer governs all collected calls).

  The error message now reflects the actual timeout (`RPC 'foo/bar' timed out after 120s` instead of always saying "30s"), and the device-sleep detection threshold scales with the effective timeout so longer overrides don't misfire as `SLEEP_TIMEOUT`.

- **Structured guard error codes + descriptive `.load()` error.** Two ergonomics fixes that work together:

  - **Bare `Error` thrown from a `guard()` is now auto-classified.** Previously, `throw new Error('login required')` from a guard reached the client as `INTERNAL_ERROR` (5xx-class, generic "Internal server error" message). Now it becomes `UNAUTHENTICATED` when `ctx.user` is null, `FORBIDDEN` when present - 4xx-class with the matching generic message ("Authentication required" / "Access denied"). The original error is preserved on `.cause` for server-side logging without leaking to the wire. Throwing `new LiveError('FORBIDDEN', 'Account suspended')` directly continues to propagate code AND message verbatim, for guards that want a specific reason.

  - **`.load()` on a guarded stream now throws a descriptive Error when called without a user.** Previously it warned in dev and called the guard with `ctx.user = null`, producing a confusing downstream failure. Now omitting `user` entirely is treated as a developer mistake and surfaces immediately:

    ```
    [svelte-realtime] 'audit/feed' has a guard but .load() was called without a user.
      Pass it explicitly:    stream.load(platform, { user: locals.user })
      Or opt into anonymous: stream.load(platform, { user: null })
      See: https://svti.me/ssr
    ```

    Passing `user: null` explicitly continues to bypass this check (anonymous opt-in), so apps that legitimately call guarded streams without a user (e.g., a public read with a permissive guard) keep working.

  - **Access predicates now pick the right code too.** `live.stream({ access: () => false })` previously always returned `FORBIDDEN`; now returns `UNAUTHENTICATED` when `ctx.user` is null and `FORBIDDEN` otherwise.

  Standard guard / framework codes are now documented on `LiveError`: `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, `VALIDATION`, `OVERLOADED`, `CONFLICT`, `SERVICE_UNAVAILABLE`, `NOT_FOUND`, `INVALID_REQUEST`, `INTERNAL_ERROR`. User-thrown codes (e.g. `INSUFFICIENT_FUNDS`) continue to pass through unchanged.

- **`live.admission({ classes })` + `ctx.shed(className)` + `classOfService` option** - pressure-aware shedding. Configure named classes of service, each mapped to either an array of pressure reasons or a `(snapshot) => boolean` predicate; the framework evaluates them against the adapter's `platform.pressure` snapshot.

  Two ways to act on the result:

  - **Manual**: `if (ctx.shed('background')) throw new LiveError('OVERLOADED', 'try again later');` - the handler decides what to do (throw, return cached, log, etc.).
  - **Declarative**: `live.stream(topic, loader, { classOfService: 'background' })` - the server auto-rejects new subscribes to that stream with `OVERLOADED` when the class's rule matches current pressure. Existing subscribers are unaffected.

  ```js
  // hooks.server.js
  import { live } from 'svelte-realtime';

  live.admission({
    classes: {
      critical:    [],                                          // never shed
      interactive: ['MEMORY'],                                  // shed only on memory pressure
      background:  ['MEMORY', 'PUBLISH_RATE', 'SUBSCRIBERS']    // shed on any pressure
    }
  });

  // src/live/browse-list.ts
  export const browseList = live.stream('browse:list', loader, {
    classOfService: 'background'
  });
  ```

  Zero overhead when never called: `ctx.shed` returns `false` and `classOfService` is a no-op without `live.admission(...)`. Unknown class names throw at runtime (typo defense). Pressure reasons are validated at registration: `MEMORY`, `PUBLISH_RATE`, `SUBSCRIBERS`, `NONE` - mirroring the adapter's enum.

- **`delta.fromSeq(sinceSeq)` on `live.stream()`** - the user-provided bridge tier for three-tier reconnect. When a client reconnects with a `seq` older than the bounded replay buffer can satisfy, the server now calls `delta.fromSeq(clientSeq)` to fetch missed events from the durable store (typically Postgres) before falling back to a full rehydrate. Resolution order on subscribe-with-seq is now:

  1. **Replay buffer** (`platform.replay.since`) - bounded, fast.
  2. **`delta.fromSeq(clientSeq)`** - user-provided database query, unbounded.
  3. **Full rehydrate** via the loader - always safe.

  Returning `null`/`undefined` falls through to the next tier. Returning `[]` means "nothing missed" (no-op for the client). Each event should carry a `seq` field so the client's `_lastSeq` advances; if events lack `seq`, the response's top-level `seq` falls back to `platform.replay.seq(topic)` when available.

  ```js
  export const auditFeed = live.stream(
    (ctx, orgId) => `audit:${orgId}`,
    async (ctx, orgId) => loadRecentAudit(orgId),
    {
      replay: true,
      delta: {
        fromSeq: async (sinceSeq) => db.audit
          .where('seq', '>', sinceSeq)
          .orderBy('seq', 'asc')
          .get()
      }
    }
  );
  ```

  Coexists with the existing schema-version `delta.version` / `delta.diff` (orthogonal - schema vs event continuity).

- **`coalesceBy` option on `live.stream()`** turns a stream into a latest-value stream under backpressure. With `coalesceBy: (data) => data.auctionId` set, every `ctx.publish(topic, event, data)` for that stream's topic fans out via the adapter's per-socket `sendCoalesced` instead of broadcasting via `publish`. Each subscriber holds at most one pending message per `(topic, coalesceBy(data))` key: if a newer publish arrives before the previous frame drains to the wire, the older value is dropped in place. Latest value wins. Use for high-frequency streams where intermediate values are noise: price ticks, cursor positions, presence state, scrub positions. For at-least-once delivery, leave the option unset and the broadcast path is byte-identical to today.

  ```js
  export const auctionPrice = live.stream(
    (ctx, auctionId) => `auction:${auctionId}`,
    async (ctx, auctionId) => loadCurrentPrice(auctionId),
    { merge: 'set', coalesceBy: (data) => data.auctionId }
  );
  ```

- **`live.idempotent({ keyFrom?, store?, ttl? }, fn)`** wraps an RPC handler so that retries with the same key return the cached result without re-running the handler. Two ways to supply the key:
  - **Server-derived:** `keyFrom: (ctx, input) => \`order:${ctx.user.id}:${input.clientOrderId}\`` - the framework computes the key, the client doesn't need to know about idempotency.
  - **Client-supplied:** the client calls `createOrder.with({ idempotencyKey: crypto.randomUUID() })(payload)` and the key rides on the wire envelope.

  Default TTL is 48 hours. Default store is a bounded in-process map (zero-config). Concurrent in-flight calls with the same key share one handler invocation; only successful results are cached, so a thrown handler aborts the slot and the next caller re-runs. Composes with `live()`, `live.validated()`, `live.rateLimit()`, and other wrappers. For multi-instance deployments, pass `store: createIdempotencyStore(redis)` from `svelte-adapter-uws-extensions/idempotency` - the in-process store and the distributed store implement the same three-state `acquire(key, ttlSec)` contract, so the swap is a one-line change.

  Until now, the only client-side dedup was a microtask-window collapse of identical RPC calls (`_dedupMap`). That helped against double-clicks but did nothing for a retry 200 ms later: the server happily re-ran the handler. This closes that gap.

## [0.4.23] - 2026-04-27

### Fixed

- **`live.metrics()` documentation now matches a working integration.** The README's "Prometheus metrics" example imported a non-existent `createMetricsRegistry` from `svelte-adapter-uws-extensions/prometheus`, and the `server.d.ts` JSDoc example imported a non-existent `createRegistry`. The real export is `createMetrics`, and its registry methods take positional args (`counter(name, help, labelNames)`) where `live.metrics()` calls them with options-object form (`counter({ name, help, labelNames })`). The README now shows a six-line adapter that bridges the two and is paired with `metrics.handler` for the `/metrics` endpoint. JSDoc and type declarations updated to match.

### Added

- **`MetricsRegistry` interface in `server.d.ts`.** TypeScript users now get autocomplete and structural validation on the registry shape passed to `live.metrics()`, replacing the previous `registry: any` signature.
- **Integration test exercising the real extensions registry.** `test/server.test.js` now imports `createMetrics` from `svelte-adapter-uws-extensions/prometheus` and runs the documented adapter shim against it, asserting that RPC counters, the duration histogram, the error counter, the stream subscription gauge, and the cron counter all flow through to the registry's serialized output. Catches future regressions in either package's exports or method shape.

---

## [0.4.22] - 2026-04-17

### Added

- **`configure({ auth })` forwards to the adapter's connect preflight.** Pass `true` to use the default `/__ws/auth` path or a string to override it. Required behind Cloudflare Tunnel and other strict edge proxies that silently drop `Set-Cookie` on WebSocket `101 Switching Protocols` responses, and to opt into the `authenticate` hook shipped in `svelte-adapter-uws` 0.4.12. Fully backwards compatible - callers that don't pass `auth` behave identically. Until now this required reaching past `svelte-realtime/client` to seed the adapter singleton manually.
- **Cloudflare-Tunnel symptom detector.** When the client observes two consecutive WebSocket `open -> close` cycles inside one second with no time spent in the open state, it logs a one-shot `console.warn` pointing at `https://svti.me/cf-cookies` with the fix. The warning is suppressed when `configure({ auth })` is already set. This catches the silent-1006 production failure mode that traditionally takes hours to diagnose.

### Changed

- **Peer dependency `svelte-adapter-uws` bumped to `>=0.4.12`** so the new `auth` option and `authenticate` hook are guaranteed to be available. Older versions silently ignored unknown `connect()` options anyway, but pinning the floor makes the new docs trustworthy.

---

## [0.4.21] - 2026-04-16

### Breaking Changes

- **Stream store errors no longer replace the data value.** Previously, connection failures, timeouts, and rejected fetches set the store value to `{ error: RpcError }`, replacing whatever data was there. This caused `($store ?? []).filter(...)` and similar patterns to crash with a TypeError because the error object is truthy but not an array. The store value now always holds your data type (or `undefined` while loading). Errors are surfaced on a separate `.error` store instead.

  **Migration:** Replace `$store?.error` checks with `store.error` (a `Readable<RpcError | null>`):

  ```diff
  - {#if $messages?.error}
  -   <p>{$messages.error.message}</p>
  + const err = messages.error;
  + {#if $err}
  +   <p>{$err.message}</p>
  ```

  Code that only uses `$store === undefined` for loading and otherwise treats the value as data requires no changes.

### Added

- **`.error` and `.status` reactive stores on every stream.** `store.error` is a `Readable<RpcError | null>` that holds the current error (or `null` when healthy). `store.status` is a `Readable<'loading' | 'connected' | 'reconnecting' | 'error'>` that tracks connection state. Both clear automatically on successful reconnect and reset on cleanup.

---

## [0.4.20] - 2026-04-14

### Fixed

- **`live.derived()` recomputation now receives `ctx.user` from the subscribing client.** Dynamic derived compute functions that check `ctx.user` (e.g. auth guards like `if (orgId !== ctx.user.organization_id)`) previously crashed with a TypeError because `ctx.user` was always null during recomputation. The user data from the first subscriber is now stored on the derived instance and passed through to the compute function.
- **Lazy-registered derived streams no longer prevent `_activateDerived` from wrapping `platform.publish`.** When `__registerDerived` received a lazy loader, it returned before setting `_hasDynamicDerived = true`, causing `_activateDerived` to skip wrapping if called before the lazy queue resolved. The flag is now set eagerly when the lazy entry is queued.
- **Dynamic derived topic separator changed from `\x00` to `~`.** The null byte separator was rejected by svelte-adapter-uws at multiple levels: the `esc()` envelope quoter throws on control characters, and subscribe validation silently drops topics containing them. Dynamic derived topics now use `~` (e.g. `dashboard/stats~org_123`), which is printable and compatible with the adapter's topic constraints.

### Added

- **Dev-mode warning when `_activateDerived(platform)` was not called.** When a client subscribes to a `live.derived()` stream and `_activateDerived` has never been called, a one-time console warning is emitted in non-production environments. This catches the silent misconfiguration where SSR hydration works but live updates never arrive.

---

## [0.4.19] - 2026-04-13

### Added

- **Standard Schema support for `live.validated()`.** Any [Standard Schema](https://standardschema.dev/)-compatible validator now works out of the box - Zod, ArkType, Valibot v1+, and others. The `~standard` interface is checked first; existing Zod `.safeParse` and Valibot `._run` paths are preserved as legacy fallbacks. Async schemas are rejected with a clear error. (PR #3 by @joshua1)

---

## [0.4.18] - 2026-04-12

### Fixed

- **`live.derived()` streams now subscribe correctly via RPC.** Derived streams were using an auto-generated `__derived:` topic prefix that collided with the reserved-prefix validation in the RPC handler, silently rejecting every subscription. `__registerDerived` now overrides the topic to use the stream path (e.g. `dashboard/stats` instead of `__derived:7`), which is consistent with how every other stream type works. Dynamic derived topics use the same path base with args appended (`dashboard/stats~orgId`). No special-case exemption needed in the validation layer.
- **Hydrated `live.derived()` stores preserve SSR data through initial subscription.** The server marks derived stream responses with a `derived` flag so the client keeps the existing hydrated value instead of replacing it with a potentially stale result. Live updates via WebSocket still apply normally on top of the hydrated data.

---

## [0.4.17] - 2026-04-12

### Fixed

- **Hydrated channel and derived stores no longer flash to empty on initial subscribe.** Added the `derived` response flag to the server and extended the client-side hydration guard to cover derived streams alongside channels.

---

## [0.4.16] - 2026-04-12

### Added

- **Dynamic `live.derived()` streams.** Source topics can now be parameterized with runtime arguments. Pass a factory function instead of a static array as the first argument: `live.derived((orgId) => [\`members:\${orgId}\`], async (ctx, orgId) => { ... })`. Each unique set of args creates an independent server-side instance with its own source subscriptions and debounce timer. Instances are created when the first subscriber connects and cleaned up automatically when the last subscriber disconnects. On the client, dynamic derived streams are called as functions, just like dynamic `live.stream()`.

---

## [0.4.15] - 2026-04-11

### Added

- **`max` option for `crud` merge strategy.** When set, the client-side buffer drops the oldest items after a `created` event exceeds the cap. In prepend mode, items are trimmed from the end of the array. In append mode, items are trimmed from the start. The key index is maintained correctly after trimming. The default for `crud` is 0 (unlimited), so existing streams are unaffected. The `latest` default remains 50. Use `{ merge: 'crud', prepend: true, max: 200 }` to cap live feeds.
- **`empty` store export.** A `Readable<undefined>` store is now exported from `svelte-realtime/client` and automatically re-exported from every generated `$live/` module. Use it as a fallback for conditional streams without needing `import { readable } from 'svelte/store'`. The generated `$types.d.ts` includes the typed export.

---

## [0.4.14] - 2026-04-10

### Changed

- Added "What the extensions handle" summary to the Redis multi-instance section, documenting cross-instance echo suppression, microtask-batched pipelines, distributed presence with zombie cleanup, replay buffer sequencing, cross-instance rate limiting, and circuit breakers.
- Added "Failure modes" section documenting what happens when Redis goes down, an instance crashes, a client reconnects after a long disconnect, send buffers overflow, and batch/queue limits are hit.
- Expanded "Clustering" section with worker architecture details: SO_REUSEPORT vs acceptor mode, batched cross-worker IPC, health monitoring with heartbeat/timeout, exponential backoff restart, and graceful shutdown behavior.
- Renamed "Limits and gotchas" to "Production limits" and added per-limit behavior descriptions, plus previously undocumented limits: presence refs (10,000), rate-limit identities (5,000), throttle/debounce timers (5,000), and topic length (256 characters).
- Mentioned Postgres LISTEN/NOTIFY as a peer alternative to Redis for cross-instance pub/sub.
- Clarified the benchmarks section to describe what is being measured (full-stack overhead including serialization, routing, and context construction, not transport protocol latency).

## [0.4.13] - 2026-04-09

### Fixed

- `.load()` now warns in dev mode when a guarded module runs with `ctx.user = null`, which usually means `{ user }` was not passed in the options. The warning fires once per path and includes the fix: `stream.load(platform, { user: locals.user })`.
- Generated `$types.d.ts` `.load()` signatures now include `user?` in the options type. Previously only `args?` was typed, so passing `{ user: locals.user }` triggered a TypeScript error even though it worked at runtime.

### Changed

- The SSR hydration example in the README now shows `{ user: locals.user }` being passed to `.load()`.
- Expanded the cross-origin and native app usage section in the README with a standalone client example using `__rpc()` and `__stream()`, and a dual cookie/token auth pattern for the upgrade hook.

## [0.4.12] - 2026-04-09

### Fixed

- RPC path validation now allows hyphens in module names. A live module at `src/live/email-queue.ts` produces the path `email-queue/queueStats`, which was rejected by the server before the handler was even resolved.

## [0.4.11] - 2026-04-09

### Fixed

- Hydrated channel streams no longer flash to empty on initial subscribe or WebSocket reconnect. Channel responses from the server return an empty placeholder (`null` or `[]`) since they have no loader. Previously this overwrote the hydrated SSR data, causing a visible glitch where derived values briefly dropped to zero or empty before live events arrived. The server now marks channel responses so the client can hold the existing value instead of replacing it.

## [0.4.10] - 2026-04-08

### Added

- `configure({ url })` option for cross-origin and native app usage. When set, the client connects to the given WebSocket URL instead of the same-origin default. This enables Svelte Native, React Native, and standalone clients to use a remote SvelteKit backend as their realtime server. Requires `svelte-adapter-uws` 0.4.8+.

## [0.4.9] - 2026-04-07

### Fixed

- SSR stubs for stream exports now include a `.hydrate()` method. Previously, calling `messages.hydrate(data)` or `stats(orgId).hydrate(data)` during server-side rendering crashed because the SSR stub was a bare `readable(undefined)` with no `.hydrate()` method.

## [0.4.8] - 2026-04-07

### Fixed

- `live()`, `live.stream()`, `live.channel()`, `live.binary()`, `live.rateLimit()`, `live.validated()`, `middleware()`, guards, rooms, pipes, and `compose()` now accept `LiveContext<UserData>` in callback signatures. Previously, annotating `ctx` as anything other than `LiveContext` (default `LiveContext<unknown>`) caused a TypeScript error due to contravariant parameter checking.
- Generated `$types.d.ts` declarations now use `StreamStore<T>` instead of `Readable<T>` for stream, channel, derived, and aggregate exports. This exposes `.hydrate()`, `.optimistic()`, `.loadMore()`, and other `StreamStore` methods in autocomplete and type checking.
- Generated `$types.d.ts` declarations now include a `.load()` method type on all stream-like exports, matching the runtime SSR stubs. `messages.load(platform)` in `+page.server.ts` no longer requires a type assertion.

## [0.4.7] - 2026-04-02

### Fixed

- Added missing type declarations for `unsubscribe`, `onError`, `live.metrics`, `live.breaker` in `server.d.ts` and `onDerived` in `client.d.ts`. These exports existed at runtime since 0.4.0 but were absent from the `.d.ts` files, causing "has no exported member" errors in TypeScript projects.

## [0.4.6] - 2026-03-22

### Changed

- Added docs site branding to README and replaced inline error URLs with svti.me short URLs across client, server, and vite plugin error messages.

## [0.4.5] - 2026-03-20

### Fixed

- Batched stream subscribes (multiple streams subscribing in the same microtask) now correctly receive their topic, merge strategy, and initial data. The batch response handler was resolving stream entries with `result.data` instead of the full response envelope, so the topic subscription was never created and initial data was lost.

## [0.4.4] - 2026-03-20

### Fixed

- Streams using `set` or `latest` merge strategies now receive live events after reconnection. Server-provided stream options (merge, key, prepend, max) were applied after the delta sync `unchanged` early return, so reconnecting clients kept the default `crud` merge and silently dropped events.

## [0.4.3] - 2026-03-20

### Fixed

- CLI scaffolder: fixed missing `package.json` file reference, added `--no-add-ons` and `--no-install` flags to `sv create` to prevent interactive prompts hanging under `stdio: pipe`, and updated stale vite config template.

## [0.4.2] - 2026-03-20

### Fixed

- CLI scaffolder: fixed failure on Windows where `sv create` prompted interactively and hung because `stdio: pipe` swallowed the prompts, causing the project directory to never be created.

## [0.4.1] - 2026-03-20

### Fixed

- Added missing `cli-utils.js` to package.json `files` array, fixing `npx svelte-realtime` failing with a module-not-found error.

---

## [0.4.0] - 2026-03-20

### Breaking Changes

#### Package

- **Peer dependency changed from `svelte-adapter-uws >=0.2.0` to `>=0.4.0`.** Core adapter must be upgraded first.
- **Version bumped from 0.1.9 to 0.4.0** to align with the adapter release.

#### Server Hooks

- **New `unsubscribe` hook must be exported from `hooks.ws.js`.** Previously only `message` and `close` were needed. Now export all three: `export { message, close, unsubscribe } from 'svelte-realtime/server';`. The `unsubscribe` hook fires in real time when a client drops a topic (adapter 0.4.0+). **Action:** add the `unsubscribe` export to your `hooks.ws.js`.
- **`close` hook signature changed.** Now receives `{ platform, subscriptions }` instead of `{ platform }`. The `subscriptions` parameter is the Set of topics still active at disconnect time. Existing code that destructures only `platform` is unaffected.
- **`close` hook only fires `onUnsubscribe` for topics still active at disconnect time.** Previously it fired for all topics tracked in an internal map. Now the `unsubscribe` hook handles real-time topic drops; `close` only handles remaining topics. There is no double-firing.

#### Room API

- **`live.room()` with actions now requires `topicArgs` config option.** Previously the room inferred the argument count from `topicFn.length`. Now you must explicitly set `topicArgs` to the number of room-identifying args (excluding `ctx`). **Action:** add `topicArgs: N` to your room config if you use actions.
- **`onLeave` callback signature changed.** Now receives `(ctx, topic)` instead of `(ctx)`. **Action:** update your `onLeave` handlers to accept the topic parameter.
- **`onJoin` now runs after `initFn` succeeds.** Previously `onJoin` ran before `initFn`. If `initFn` throws, `onJoin` is not called (prevents orphaned side effects).

#### Validation

- **`live.validated()` now rejects unrecognized schema types.** Previously it passed input through without validation and logged a dev warning. Now it returns an error. Only Zod (`.safeParse`) and Valibot (`._run`) are supported. **Action:** ensure you are using a supported validation library.

#### Error Handling

- **`onCronError()` is deprecated.** Use `onError()` instead. `onCronError` still works but delegates to the same handler. `onError` covers cron, effects, and derived stream errors.

#### Client

- **`__binaryRpc` now accepts `ArrayBuffer | ArrayBufferView`** instead of just `ArrayBuffer`. Not breaking for callers passing `ArrayBuffer`, but the type signature changed.
- **Stream reconnect backoff changed.** Old: fixed 50-200ms random delay. New: first two attempts use 20-100ms, then exponential backoff up to 5 minutes with jitter. Observable timing difference, not an API change.
- **`batch()` listener merged into the main RPC listener.** The separate `ensureBatchListener()` function was removed. Batch responses are now handled inside the main `__rpc` topic subscriber. No API change, but internal wiring is different.

### Added

#### CLI Scaffolding

- **`npx svelte-realtime my-app`** - interactive project scaffolder. Creates a SvelteKit project with adapter, vite plugins, WebSocket hooks, and a working counter example.

#### Server API

- `ctx.batch(messages)` - publish multiple messages in one call via `platform.batch()`.
- `live.metrics(registry)` - opt-in Prometheus metrics for RPC calls, stream subscriptions, and cron executions.
- `live.breaker(options, fn)` - circuit breaker wrapper. When open, returns a fallback value or throws `SERVICE_UNAVAILABLE`.
- `onError(handler)` - global error handler for server-side errors (cron, effects, derived streams). Replaces `onCronError`.
- `unsubscribe` export from `svelte-realtime/server` - ready-made unsubscribe hook for `hooks.ws.js`.
- Room `.hooks` property - one-liner wiring: `export const { message, close, unsubscribe } = myRoom.hooks;`.

#### Client API

- `onDerived` re-exported from `svelte-adapter-uws/client` - reactive derived topic subscription.
- `configure({ timeout })` - configurable RPC timeout (default 30s).
- Terminal close code handling - codes 1008, 4401, 4403 stop reconnection. After terminal close, all pending RPCs reject with `CONNECTION_CLOSED`, stream stores receive `{ error }`, and the offline queue is drained with errors.
- Device sleep detection - if a timeout fires >90s after its scheduled time, assumes device was sleeping and rejects with `DISCONNECTED` instead of `TIMEOUT`.
- Microtask-batched stream subscribes - multiple subscribe RPCs within one microtask are sent as a single batch frame.

#### Stream Enhancements

- Replay truncation handling - when the replay extension sends `{ reqId, truncated: true }`, the client resets its sequence number and triggers a full refetch.
- Server-provided stream options (merge, key, prepend, max) are now applied BEFORE processing diffs/replay, ensuring the correct merge strategy is used from the start.
- `unchanged` response now drains buffered events after re-subscribing to the topic.
- Topic listener is attached BEFORE flipping `initialLoaded`, preventing events from being dropped during the window between server-side `ws.subscribe(topic)` and client-side listener setup.

#### Validation

- Reserved topic prefix `__` is now rejected at definition time for `live.stream()` and `live.channel()`.
- Async topic functions are rejected at definition time with a clear error message.
- Binary RPC header size validated (rejects >65535 bytes with `PAYLOAD_TOO_LARGE`).

#### Documentation (README)

- Quick start section with `npx svelte-realtime my-app`.
- `ctx.batch()` documentation and server-side batching example.
- Terminal close codes section.
- Prometheus metrics section.
- Circuit breaker section.
- Tauri and Capacitor integration guide.
- Room hooks shortcut documentation.
- Replay truncation handling documentation.

### Changed (Under the Hood)

#### Performance

- **Swap-remove for array deletions** in crud, presence, and cursor merge strategies. Replaces `Array.splice()` + index rewrite (O(n)) with O(1) swap-and-truncate. Applies to both client stores and benchmarks.
- **Double-buffer swap pattern** for RAF event batching. Reuses two pre-allocated arrays per frame instead of allocating new ones.
- **RAF dedup** for idempotent events (updated, update, join). Within a single frame, keeps only the last event per entity key.
- **Reusable binary frame buffer** for binary RPC calls. Grows by 2x to avoid frequent reallocation.
- **Ring buffer for devtools history** (O(1) insertion instead of array.shift).
- **O(1) stream cache eviction** using an evictable set instead of full cache scan.
- **Deferred stream cleanup via queueMicrotask** prevents thrashing on rapid unsubscribe+resubscribe cycles.
- **Overflow dedupe map** for stream cache - active stores that exceed the main cache limit are tracked separately.
- Dedupe key encoding uses typed prefixes (`S`, `#`, `B`, `N`, `U`) to avoid ambiguity between types.
- `_dirty` flag skips store.set when merge produces no change (e.g. `set` merge with identical value).
- Cron field parser accepts field index for better error messages.
- `_copyStreamMeta()` consolidates metadata copying for `gate()`, `pipe()`, and wrappers.
- `_buildCtx()` factory ensures monomorphic V8 hidden class for ctx objects.
- `_propagateRateLimitPath()` walks wrapper chains (validated → rateLimit) to set path on nested wrappers.
- Rate limit identity uses stable per-connection guest IDs instead of `'anon'` for unauthenticated users.
- Rate limit hard cap only applies to new buckets - existing identities always pass through.
- Stream history recording skips arrays >200 items to avoid excessive memory.
- Aggregate `__registerAggregate` hydrates snapshot asynchronously at registration time.

#### Reliability

- Stream subscription rollback (`_rollbackStreamSubscribe`) - if `initFn` throws after `ws.subscribe(topic)`, the subscription is undone and `onUnsubscribe` fires.
- Per-socket stream ownership tracking (`_wsStreamOwners`) with refcounting replaces the old `_dynamicSubscriptions` WeakMap.
- Room presence uses per-topic+userId refcounting with grace period timers to handle multi-tab scenarios without phantom leaves.
- Reconnect attempts tracked per stream with exponential backoff (base 2.2, max 5min, 25% jitter). Reset on successful fetch.
- Vite plugin: `_warnUnsafeExports()` checks for export names with characters invalid in RPC paths.
- Vite plugin: improved stream option extraction with proper brace/bracket/string parsing.

---

## [0.1.9] and earlier

See [git history](../../commits/main) for changes prior to 0.4.0.
