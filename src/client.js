// @ts-check
export { assert, getAssertionCounters, _resetAssertCounters } from './shared/assert.js';
export { colorForKey, hueForKey } from './shared/color.js';
export { __devtools } from './client/devtools-instrument.js';
export { quiescent, _resetQuiescence, health, degradation, _resetHealth, _setSmoothDegraded, _setCrdtDegraded } from './client/health.js';
export { RpcError, empty, MAX_OPTIMISTIC_QUEUE_DEPTH, _setCapsForTest, _resetCapsForTest, _resetDedupCoalesceWarned } from './client/internal-state.js';
export { __upload, _resetUploadAutoDiscovery } from './client/upload.js';
export { __rpc, __binaryRpc, __mpFields, batch, _resetClientPublishRateWarning } from './client/rpc.js';
export { configure, combine, onSignal, onPush, _resetPushHandlers } from './client/misc.js';
export { pendingMutations, uploading, offlineCheckpoint, _resetOffline } from './client/offline.js';
export { createIndexedDbStore, createMemoryStore } from './client/offline-store.js';
export { __stream, _createStreamAtSchemaVersion, createReactiveStream } from './client/stream.js';

/**
 * The adapter client's `onDerived`, `failure` and `status`, read from the
 * connection this client is bound to, so that after a close for good they
 * report the closed connection instead of opening a new one.
 *
 * `onDerived` is a reactive derived topic subscription that auto-switches
 * when a source store changes. More lightweight than dynamic streams for
 * cases where you just want raw topic events keyed to a store value.
 *
 * `failure` carries the cause of the most recent non-open status transition:
 * `{ kind: 'ws-close', class: 'TERMINAL' | 'EXHAUSTED' | 'THROTTLE' |
 * 'RETRY' | 'DRAIN', code, diagnosticReason }` for WebSocket closes, or
 * `{ kind: 'auth-preflight', class: 'AUTH', status, diagnosticReason }` for
 * auth-preflight failures. `null` while connected. Cleared on the next
 * successful `'open'`. Not set on intentional `close()`.
 *
 * `status` holds the connection status: 'connecting', 'open', 'suspended'
 * (WebSocket open but the tab is backgrounded), 'disconnected' (will retry),
 * or 'failed' (terminal). The generated multiplayer namespace exposes this as
 * its `status` view so a collaborative surface can react to connectivity
 * without a separate adapter import.
 */
export { onDerived, failure, status } from './client/connection.js';

/**
 * Re-export `createSharedRandom` from the adapter's smooth plugin. The deterministic
 * generator `live.smooth`'s `apply` receives as `ctx.rng`, exposed so client code can
 * draw the same reproducible randomness outside `apply` (world generation, spawns,
 * deterministic tests) by reseeding from a stable id.
 */
export { createSharedRandom } from 'svelte-adapter-uws/plugins/smooth/random';
