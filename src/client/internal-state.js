// @ts-check
import { readable } from 'svelte/store';
import { randomFloat } from '../client-runtime.js';

/**
 * Cross-module mutable client state. Only genuinely cross-module scalars live on
 * this holder; per-module lets travel with their owning module. The hot scalars
 * (batchCollector / terminated / config / isOffline) are plain properties - a
 * property read costs the same as a local read with no getter/setter call - so
 * the per-RPC and per-send gates keep their cost. Mirrors the server state holder.
 *
 * @type {{
 *   batchCollector: Array<{ rpc: string, id: string, args: any[] }> | null,
 *   terminated: boolean,
 *   config: any,
 *   isOffline: boolean,
 *   maxOptimisticQueueDepth: number
 * }}
 */
export const clientState = {
	batchCollector: null,
	terminated: false,
	config: {},
	isOffline: false,
	maxOptimisticQueueDepth: 1_000
};

/** @type {import('svelte/store').Readable<undefined>} */
export const empty = readable(undefined);

const _textEncoder = new TextEncoder();

/** Dev-mode flag. True when not running under a Vite production build
 * (and true under vitest, where `import.meta.env.PROD` is undefined).
 * Gates dev-only warnings and devtools instrumentation. */
const _IS_DEV = typeof import.meta === 'undefined' || !import.meta.env || !import.meta.env.PROD;

// - Bounded-by-default capacity caps (client side) -------------------------
// Existing caps not re-declared (already enforced at their sites):
//   _historyMax           50    FIFO    per-stream undo/redo
//   _MAX_STREAM_EVENTS    20    FIFO    per-stream devtools event ring
//   _DEVTOOLS_HISTORY_MAX 50    FIFO    devtools call history ring
// See README "Capacity model" for the full taxonomy.

/** Max in-flight optimistic mutations per stream. REJECT on cap: `mutate()` throws synchronously. Bounds the worst-case display-recompute cost during slow-server scenarios. Matches svelte-adapter-uws `MAX_QUEUE_SIZE` (the per-connection client send queue) since both serve as UI-layer in-flight burglar alarms. */
export const MAX_OPTIMISTIC_QUEUE_DEPTH = 1_000;

/**
 * Override capacity caps for testing.
 * @internal
 * @param {{ optimisticQueueDepth?: number }} overrides
 */
export function _setCapsForTest(overrides) {
	if (overrides.optimisticQueueDepth !== undefined) clientState.maxOptimisticQueueDepth = overrides.optimisticQueueDepth;
}

/**
 * Restore capacity caps to defaults.
 * @internal
 */
export function _resetCapsForTest() {
	clientState.maxOptimisticQueueDepth = MAX_OPTIMISTIC_QUEUE_DEPTH;
}

/** Pre-allocated binary frame buffer for reuse across sequential binary RPC calls */
let _binaryFrameBuffer = /** @type {Uint8Array | null} */ (null);
let _binaryFrameSize = 0;

/**
 * Get a reusable binary frame buffer of at least `size` bytes.
 * Grows by 2x to avoid frequent reallocation.
 * @param {number} size
 * @returns {Uint8Array}
 */
function _getBinaryFrame(size) {
	if (!_binaryFrameBuffer || _binaryFrameSize < size) {
		_binaryFrameSize = Math.max(size, (_binaryFrameSize || 1024) * 2);
		_binaryFrameBuffer = new Uint8Array(_binaryFrameSize);
	}
	return _binaryFrameBuffer;
}

/**
 * RAF-based event batching for high-frequency streams (cursors, presence).
 * In the browser, incoming pub/sub events are queued and flushed once per
 * animation frame, reducing Svelte reactive updates from N-per-event to
 * 1-per-frame. In Node/SSR, events apply synchronously (no DOM to protect).
 */
const _useRAF = typeof window !== 'undefined' && typeof requestAnimationFrame === 'function';

/**
 * Typed error for RPC failures.
 */
export class RpcError extends Error {
	/**
	 * @param {string} code
	 * @param {string} [message]
	 */
	constructor(code, message) {
		super(message || code);
		this.code = code;
	}
}

// Incrementing counter for short correlation IDs, prefixed to avoid cross-tab
// collision. The seeded RNG is the right primitive: this prefix is
// response-routing bookkeeping, not a session token or any value that crosses a
// trust boundary. Not security-relevant; routing it through the runtime RNG also
// lets a seeded harness reproduce request ids exactly.
const _idPrefix = randomFloat().toString(36).slice(2, 6);
let idCounter = 0;

/** Generate a unique correlation ID, wrapping the counter before exceeding safe integer range */
function _nextId() {
	if (idCounter >= 0x1FFFFFFFFFFFFF) idCounter = 0;
	return _idPrefix + (idCounter++).toString(36);
}

/** @type {Map<string, Promise<any>>} */
const _dedupMap = new Map();

/**
 * Per-path "have we warned about microtask dedup coalescing this path
 * in this session?" gate. Dev-only, fires once per RPC path on the
 * first coalesce so a developer running `Promise.allSettled([...rpc(),
 * ...rpc()])` and expecting N parallel wire requests gets a one-line
 * pointer to `rpc.fresh(...)`. Silent thereafter so a button-mash
 * double-click on the same path doesn't spam the console. Stripped
 * in production via the `_isDev()` gate at the call site.
 *
 * @type {Set<string>}
 */
const _dedupCoalesceWarned = new Set();

// - Dev-mode publish-rate hint (client half) -------------------------------
// Mirrors the server-side sampler in `svelte-realtime/server.js`, but the
// signal source differs. The server reads `platform.pressure.topPublishers`
// (rates the adapter already computes); the client has no such snapshot, so
// it measures inbound frame rate directly at the dispatch hook. A per-topic
// fixed window counts frames; when a window closes over threshold, one warn
// fires per topic per session with the SAME wording, threshold (200), and
// `svti.me/highfreq` link as the server. The whole feature is gated by the
// `import.meta.env`-folded `_IS_DEV` const so a production build strips it to
// dead code, leaving zero residue on the inbound dispatch hot path.

/** Inbound events/sec at which a topic is considered high-frequency. Matches the server sampler default. */
const _PUBLISH_RATE_HINT_THRESHOLD = 200;

/** Measurement window for the client frame-rate counter, in ms. Rate = frames-in-window / window-seconds. */
const _PUBLISH_RATE_HINT_WINDOW_MS = 1000;

/** Max distinct topics tracked in the warned dedup set. FIFO-evict on cap: dropping the oldest entry just lets that topic re-warn on its next over-threshold window. Mirrors the server `PUBLISH_RATE_WARN_DEDUP_MAX` eviction shape. */
const _PUBLISH_RATE_HINT_DEDUP_MAX = 1_000_000;

/** @type {Map<string, { start: number, count: number }>} Per-topic fixed-window frame counter. */
const _publishRateWindows = new Map();

/** @type {Set<string>} One-shot warned topics. FIFO-evicted at the dedup cap. */
const _publishRateHintWarned = new Set();

/**
 * Dev-mode check, mirrored from the `process.env.NODE_ENV` pattern
 * used elsewhere in this file. Cached once at first call so the hot
 * path is a single property read, not a chained typeof + env lookup.
 * @returns {boolean}
 */
let _devGateCached = /** @type {boolean | null} */ (null);
function _isDev() {
	if (_devGateCached !== null) return _devGateCached;
	_devGateCached = (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production');
	return _devGateCached;
}

/**
 * Reset the dedup-coalesce warned set. Tests only.
 * @internal
 */
export function _resetDedupCoalesceWarned() {
	_dedupCoalesceWarned.clear();
	_devGateCached = null;
}

/** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> | null }>} */
const pending = new Map();

export { _textEncoder, _IS_DEV, _getBinaryFrame, _useRAF, _nextId, _dedupMap, _dedupCoalesceWarned, _PUBLISH_RATE_HINT_THRESHOLD, _PUBLISH_RATE_HINT_WINDOW_MS, _PUBLISH_RATE_HINT_DEDUP_MAX, _publishRateWindows, _publishRateHintWarned, _isDev, pending };
