// @ts-check

export const LIVE_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\s*\(/g;
export const VALIDATED_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.validated\s*\(/g;
export const STREAM_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.stream\s*\(/g;
export const GUARD_EXPORT_RE = /export\s+const\s+(_guard)\s*=\s*guard\s*\(/g;
export const DYNAMIC_STREAM_RE = /export\s+const\s+(\w+)\s*=\s*live\.stream\s*\(\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g;
export const CRON_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.cron\s*\(/g;
export const BINARY_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.binary\s*\(/g;
export const UPLOAD_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.upload\s*\(/g;
export const DERIVED_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.derived\s*\(/g;
export const DYNAMIC_DERIVED_RE = /export\s+const\s+(\w+)\s*=\s*live\.derived\s*\(\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g;
export const ROOM_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.room\s*\(/g;
// `live.multiplayer(...)` is a room export with a collaborative client surface.
// At runtime it carries `__isRoom` plus the same __data/__presence/__cursors
// sub-streams, so its registry registration is identical to a room; the client
// stub adds the aggregated `status` view and the `move`/`reportViewport`
// cursor methods on top of the room namespace.
export const MULTIPLAYER_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.multiplayer\s*\(/g;
// `live.smooth(...)` is a smoothed-entity export: the client namespace gets
// the command/sync send paths plus a `smooth(...)` factory that builds the
// predicted view. The app's shared apply() function is passed at the factory
// call site at runtime - generated code carries only paths and JSON
// literals, never serialized functions.
export const SMOOTH_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.smooth\s*\(/g;
// `live.doc(...)` / `live.map(...)` / `live.array(...)` are CRDT document
// exports: the client namespace gets the sync/update/close send paths plus a
// factory (named after the kind) that builds the reactive replica view. The
// channel comes from the adapter, the rune view classes from the
// svelte-realtime/doc subpath; generated code carries only paths and JSON
// literals.
export const DOC_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.(doc|map|array)\s*\(/g;
export const WEBHOOK_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.webhook\s*\(/g;
// Namespaced webhook forms. live.webhooks.inbound() is the same server-only
// manual handler as the flat live.webhook(); live.webhooks.outbound() is a
// leader-gated outbound POST that IS registered server-side as a topic watcher
// (like an effect). The flat regex does not match these (after `webhook` comes
// `s`, not `(`), so they need their own patterns.
export const WEBHOOK_INBOUND_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.webhooks\.inbound\s*\(/g;
export const WEBHOOK_OUTBOUND_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.webhooks\.outbound\s*\(/g;
export const CHANNEL_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.channel\s*\(/g;
export const DYNAMIC_CHANNEL_RE = /export\s+const\s+(\w+)\s*=\s*live\.channel\s*\(\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/g;
export const RATE_LIMIT_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.rateLimit\s*\(/g;
export const EFFECT_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.effect\s*\(/g;
export const AGGREGATE_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.aggregate\s*\(/g;
// `live.flag(topic, initialValue)` declares a `merge: 'set'` stream carrying
// the flag value, so the client treats it exactly like a static stream: emit
// a `__stream(..., { merge: 'set' })` stub and register it as a plain stream.
export const FLAG_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.flag\s*\(/g;
// `live.lock(...)` and `live.idempotent(...)` wrap an inner handler. From the
// client's perspective they're plain RPCs (the lock / idempotency runs
// server-side inside the wrapper), so the codegen treats them identically
// to a `live(...)` export - generate an `__rpc(...)` stub, register the
// path. Without this, exports declared as `export const x = live.lock(...)`
// would not be recognised and the client could not call them.
export const LOCK_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.lock\s*\(/g;
// `live.public(...)` is a runtime no-op wrapper (returns the handler
// unchanged) whose only job is to declare intent: "this RPC is
// intentionally public; do not warn about a missing _guard." The
// codegen treats it identically to `live(...)` for emission and uses
// the presence of any `live.public` export as a module-level suppression
// for the "no _guard" build-time warning.
export const PUBLIC_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.public\s*\(/g;
// Module-level escape hatch: a `// realtime-allow-public` comment
// anywhere in the source suppresses the "no _guard" warning for the
// whole module. Use this when several or all live() exports in a
// module are intentionally public.
export const PUBLIC_COMMENT_RE = /(?:\/\/|\/\*)\s*realtime-allow-public\b/;
export const IDEMPOTENT_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.idempotent\s*\(/g;
// `live.volatile(...)` is the fire-and-forget RPC marker. From the client's
// perspective the export is a normal RPC stub - the `.fireAndForget()` method
// is attached by the `__rpc()` factory itself - so the codegen emits the same
// `__rpc(...)` line as a plain `live()` export.
export const VOLATILE_EXPORT_RE = /export\s+const\s+(\w+)\s*=\s*live\.volatile\s*\(/g;

export const _validSegmentReVite = /^[a-zA-Z0-9_]+$/;
