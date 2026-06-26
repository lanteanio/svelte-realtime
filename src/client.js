// @ts-check
export { assert, getAssertionCounters, _resetAssertCounters } from './shared/assert.js';
export { colorForKey, hueForKey } from './shared/color.js';
export { __devtools } from './client/devtools-instrument.js';
export { quiescent, _resetQuiescence, health, degradation, _resetHealth, _setSmoothDegraded, _setCrdtDegraded } from './client/health.js';
export { RpcError, empty, MAX_OPTIMISTIC_QUEUE_DEPTH, _setCapsForTest, _resetCapsForTest, _resetDedupCoalesceWarned } from './client/internal-state.js';
export { __upload, _resetUploadAutoDiscovery } from './client/upload.js';
export { __rpc, __binaryRpc, __mpFields, batch, _resetClientPublishRateWarning } from './client/rpc.js';
export { configure, combine, onSignal, onPush, _resetPushHandlers } from './client/misc.js';
export { __stream, _createStreamAtSchemaVersion } from './client/stream.js';

/**
 * Re-export `onDerived` from the adapter client.
 * Provides a reactive derived topic subscription that auto-switches when a
 * source store changes. More lightweight than dynamic streams for cases where
 * you just want raw topic events keyed to a store value.
 */
export { onDerived } from 'svelte-adapter-uws/client';

/**
 * Re-export `failure` from the adapter client.
 * Reactive store carrying the cause of the most recent non-open status
 * transition: `{ kind: 'ws-close', class: 'TERMINAL' | 'EXHAUSTED' |
 * 'THROTTLE' | 'RETRY', code, reason }` for WebSocket closes, or
 * `{ kind: 'auth-preflight', class: 'AUTH', status, reason }` for
 * auth-preflight failures. `null` while connected. Cleared on the next
 * successful `'open'`. Not set on intentional `close()`.
 */
export { failure } from 'svelte-adapter-uws/client';

/**
 * Re-export `status` from the adapter client.
 * Reactive store holding the connection status: 'loading', 'connected',
 * 'reconnecting', or 'error'. The generated multiplayer namespace exposes this
 * as its `status` view so a collaborative surface can react to connectivity
 * without a separate adapter import.
 */
export { status } from 'svelte-adapter-uws/client';

/**
 * Re-export `createSharedRandom` from the adapter's smooth plugin. The deterministic
 * generator `live.smooth`'s `apply` receives as `ctx.rng`, exposed so client code can
 * draw the same reproducible randomness outside `apply` (world generation, spawns,
 * deterministic tests) by reseeding from a stable id.
 */
export { createSharedRandom } from 'svelte-adapter-uws/plugins/smooth/random';
