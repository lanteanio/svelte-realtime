// @ts-check
import { live, getPlatform, publish } from '../server.js';
import { _activateDynamicDerived, _deactivateDynamicDerived, _computeAggregateState, _computeWindowState } from './reactive.js';
import { _aggregateByTopic } from './state.js';
import { _normalizeAggregatePrivacy } from './differential-privacy.js';

// Seam: the flag cell/watcher and the window-spec validator stay in server.js
// (shared with the staying __register* shims); the reactive families reach them
// through this, set at init (mirrors installSmooth).
let _flagCell, _installFlagWatcher, _validateWindowSpec;
export function installReactiveFamilies(seams) {
	_flagCell = seams.flagCell;
	_installFlagWatcher = seams.installFlagWatcher;
	_validateWindowSpec = seams.validateWindowSpec;
}

// Derived streams take a stable per-registration id from this counter; its
// sole reader/writer is the derived body, so it travels with the family.
let _derivedIdCounter = 0;

/**
 * Declare a server-side feature flag exposed as a readable stream.
 *
 * A flag is a thin wrapper over `live.stream`: it declares a `merge: 'set'`
 * topic carrying the flag value, and any `.set(value)` pushes the new value
 * to every subscriber. On the client, `$live/<module>` exposes the export as
 * a readable store carrying the current value.
 *
 * Flags are cluster-consistent by default: a single-entry shared replay
 * buffer is enabled, so `.set()` writes the cluster-shared buffer and a
 * subscriber that connects fresh - to any replica, including one that never
 * set the flag locally - is served the cluster-latest value. Already-
 * subscribed clients stay in sync across the cluster as `.set()` relays the
 * update. Pass a custom `replay` object to size the buffer, or
 * `replay: false` to opt out (single-process apps lose nothing, since the
 * locally cached value is authoritative in one process).
 *
 * On every running replica an internal watcher keeps the cached value fresh
 * from boot. The watcher is installed when the registry module loads (the
 * same moment `live.effect` watchers become active), so it does not wait for
 * the flag module's first local import or subscribe: an inbound `set` relayed
 * from any replica updates the cached value within a tick, and the synchronous
 * `.get()` reflects the cluster-latest value on any running instance. For a
 * strict read on a replica that booted AFTER the last `set` and has not yet
 * received any inbound `set` (the watcher only catches post-boot sets), use the
 * asynchronous `getLatest()`, which reads the shared buffer directly.
 *
 * The `.set(value)` method publishes through the framework-owned platform
 * (the same path as the top-level `publish()` helper), so the new value
 * reaches every local subscriber and relays across the cluster when a bus
 * is wired. Call it from any server context after the platform has been
 * captured (RPC handler, cron tick, effect, an admin `+server.js` route).
 *
 * @param {string} topic - Topic carrying the flag value
 * @param {any} [initialValue] - Value served to subscribers before the first `.set`
 * @param {{ replay?: boolean | { size?: number } }} [options]
 * @returns {Function & { set(value: any): any, get(): any, getLatest(): Promise<any> }}
 *
 * @example
 * ```js
 * // src/live/flags.js
 * import { live } from 'svelte-realtime/server';
 * export const maintenance = live.flag('flag:maintenance', false);
 *
 * // Flip it from any handler:
 * export const toggleMaintenance = live(async (ctx, on) => {
 *   maintenance.set(on);
 * });
 * ```
 *
 * ```svelte
 * <script>
 *   import { maintenance } from '$live/flags';
 * </script>
 * {#if $maintenance}<Banner />{/if}
 * ```
 */
export const _flagRegister = function flag(topic, initialValue, options) {
	if (typeof topic !== 'string' || topic.length === 0) {
		throw new Error('[svelte-realtime] live.flag topic must be a non-empty string');
	}
	// The flag's value lives in a per-topic cell shared with the eager
	// registry-load watcher (installed by `__registerFlag`). Binding to the
	// cell instead of a private closure variable decouples the value from this
	// module's import: a `set` that arrives before the module is first imported
	// is captured into the cell by the eager watcher, so the first `.get()`
	// after import reads the cluster-latest value rather than a stale init.
	const cell = _flagCell(topic, initialValue);
	const initFn = async function flagInit() { return cell.value; };
	// Replay is ON by default with a single-entry buffer so the flag's
	// topic is replay-eligible at declaration: `.set() -> publish() ->
	// _maybeReplayPublish` writes the cluster-shared buffer, and a fresh
	// subscriber (or a just-booted replica) is served the cluster-latest
	// value through the seeding branch in `_executeStreamRpc`. Pass a
	// custom `replay` object to override the buffer size, or `replay: false`
	// to opt out (single-process apps lose nothing - the cached value is
	// authoritative in one process).
	const streamOpts = { merge: 'set' };
	if (options && options.replay === false) {
		// opt out: leave replay unset
	} else if (options && options.replay) {
		/** @type {any} */ (streamOpts).replay = options.replay;
	} else {
		/** @type {any} */ (streamOpts).replay = { size: 1 };
	}
	const stream = live.stream(topic, initFn, streamOpts);
	/** @type {any} */ (stream).__isFlag = true;
	/**
	 * Read the flag's current value on the server (synchronous). On a running
	 * replica this stays fresh from boot within a tick of any inbound `set` via
	 * the per-topic watcher installed eagerly at registry load (see
	 * `__registerFlag`). For a strict read on a replica that booted after the
	 * last `set` and has not yet received any inbound `set`, use `getLatest()`.
	 */
	/** @type {any} */ (stream).get = function get() { return cell.value; };
	/**
	 * Read the cluster-latest flag value (asynchronous). Reads the shared
	 * replay buffer when one is wired and non-empty; otherwise falls back to
	 * the locally cached value. Serves the strict read-after-cold-boot
	 * case where a replica may not yet have observed the cluster-latest set.
	 */
	/** @type {any} */ (stream).getLatest = async function getLatest() {
		// Resolve the captured platform the same way `.set()` does (via the
		// top-level `publish()` helper), so `getLatest()` reads the shared
		// buffer whether the platform was captured by `_activateDerived` or
		// `setCronPlatform`.
		const platform = getPlatform();
		const replay = platform && /** @type {any} */ (platform).replay;
		if (replay && typeof replay.since === 'function') {
			try {
				const buffered = await replay.since(topic, 0);
				if (Array.isArray(buffered) && buffered.length > 0) {
					const last = buffered[buffered.length - 1];
					if (last && 'data' in last) return last.data;
				}
			} catch {}
		}
		return cell.value;
	};
	/** Publish a new flag value to every subscriber. */
	/** @type {any} */ (stream).set = function set(value) {
		cell.value = value;
		return publish(topic, 'set', value);
	};
	// Ensure the per-topic refresh watcher is installed. This is idempotent
	// with the eager `__registerFlag` install the registry module emits, and
	// covers the cases where a flag module is imported without a generated
	// registry (the dev-mode direct-load fallback, or a flag declared inline
	// in tests).
	_installFlagWatcher(topic);
	return /** @type {any} */ (stream);
};

/**
 * Create a server-side computed stream that recomputes when any source topic publishes.
 *
 * Static form: sources is a string[] of topic names.
 * Dynamic form: sources is a function (...args) => string[] that resolves topics at subscribe time.
 *
 * @param {string[] | Function} sources - Topic names to watch, or a factory that receives runtime args
 * @param {Function} fn - Async function that computes the derived value
 * @param {{ merge?: string, debounce?: number }} [options]
 * @returns {Function}
 */
export const _derivedRegister = function derived(sources, fn, options) {
	const baseTopic = /** @type {any} */ (fn).__derivedTopic || ('__derived:' + (_derivedIdCounter++));
	const merge = options?.merge || 'set';
	const debounce = options?.debounce || 0;
	const dynamic = typeof sources === 'function';

	/** @type {any} */ (fn).__isDerived = true;
	/** @type {any} */ (fn).__isStream = true;
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__streamOptions = merge === 'crud' ? { merge, key: 'id' } : { merge };
	/** @type {any} */ (fn).__derivedDebounce = debounce;

	if (dynamic) {
		/** @type {any} */ (fn).__derivedDynamic = true;
		/** @type {any} */ (fn).__derivedSourceFactory = sources;
		/** @type {Map<string, any[]>} */
		const topicArgs = new Map();
		const topicFn = (...args) => {
			const t = baseTopic + '~' + args.map(a => String(a).replace(/~/g, '')).join('~');
			topicArgs.set(t, args);
			if (topicArgs.size > 10000) {
				const iter = topicArgs.keys();
				topicArgs.delete(iter.next().value);
			}
			return t;
		};
		/** @type {any} */ (topicFn).__topicUsesCtx = false;
		/** @type {any} */ (fn).__streamTopic = topicFn;
		/** @type {any} */ (fn).__derivedTopicArgs = topicArgs;

		/** @type {any} */ (fn).__onSubscribe = function (_ctx, resolvedTopic) {
			_activateDynamicDerived(fn, resolvedTopic, _ctx && _ctx.user);
		};
		/** @type {any} */ (fn).__onUnsubscribe = function (_ctx, resolvedTopic) {
			_deactivateDynamicDerived(fn, resolvedTopic, _ctx && _ctx.user);
		};
	} else {
		/** @type {any} */ (fn).__streamTopic = baseTopic;
		/** @type {any} */ (fn).__derivedSources = sources;
	}

	return fn;
};

/**
 * Create a server-side reactive side effect.
 * Effects fire when source topics publish. They are fire-and-forget - no data, no topic.
 *
 * @param {string[]} sources - Topic names to watch
 * @param {Function} fn - Async function (event, data, platform) called on each matching publish
 * @param {{ debounce?: number }} [options]
 * @returns {Function}
 */
export const _effectRegister = function effect(sources, fn, options) {
	const debounce = options?.debounce || 0;
	/** @type {any} */ (fn).__isEffect = true;
	/** @type {any} */ (fn).__effectSources = sources;
	/** @type {any} */ (fn).__effectDebounce = debounce;
	return fn;
};

/**
 * Create a real-time incremental aggregation over a source topic.
 * Each event runs O(1) reducers instead of requerying the database.
 *
 * **Single-state form** (no `windows`): the original behavior. One
 * state slice per reducer field, one output topic, one snapshot.
 *
 * **Windowed form** (`windows: { ... }`): declarative time-windowed
 * aggregation. One state slice per (reducer field x window), per-window
 * output topic at `${topic}:${windowName}`, per-window debounce + snapshot.
 * Supports three window types:
 *
 * - `lifetime` - never resets; equivalent to a single-state aggregate
 *   exposed as a named output for symmetry.
 * - `tumbling` - boundary-anchored. `period: 'minute' | 'hour' | 'daily'
 *   | 'monthly'` resets at the configured tz's natural boundary;
 *   `durationMs + anchor` resets at fixed intervals from a custom epoch.
 *   On boundary cross, the closing window publishes one final pre-reset
 *   state, then state is `init()`-cleared for the new window.
 * - `sliding` - hop-window with `durationMs / slideMs` buckets. Each
 *   event reduces into the current hop; on each slide, drop the oldest
 *   bucket and start a new current bucket. Reducers MUST provide a
 *   `combine(...buckets)` field so cross-bucket state can be recomputed
 *   on each publish; built-in helpers `combineSum`, `combineCounts`,
 *   `combineMax`, `combineMin`, `combineMerge` cover the common shapes.
 *
 * **Cluster mode (important).** Today's aggregate runs on every worker
 * fed by the source topic via the adapter's cluster bus. State converges
 * across workers as long as the source topic fans out to every worker
 * (the default). Sharded source topics (where each worker sees a
 * partition rather than the full firehose) will produce divergent
 * per-worker state and inconsistent per-window publishes. For sharded
 * sources, layer a leader gate later (symmetric to `configureCron({
 * leader })`) - not yet shipped.
 *
 * @param {string} source - Topic to watch for events
 * @param {Record<string, { init?: () => any, reduce?: (acc: any, event: string, data: any) => any, compute?: (state: any) => any, combine?: (...buckets: any[]) => any }>} reducers
 * @param {{ topic: string, snapshot?: () => Promise<any>, snapshots?: Record<string, () => Promise<any>>, debounce?: number, windows?: Record<string, any> }} options
 * @returns {Function}
 */
export const _aggregateRegister = function aggregate(source, reducers, options) {
	const topic = options.topic;
	const debounce = options?.debounce || 0;
	const windowsSpec = options?.windows || null;
	// k-anonymity + differential-privacy config; validated + normalized here so a
	// bad shape throws at declaration, not on the first publish. null when absent.
	const privacy = _normalizeAggregatePrivacy(options?.privacy, topic);

	// Build initial state from init() functions
	const initState = {};
	for (const [field, r] of Object.entries(reducers)) {
		if (r.init) initState[field] = r.init();
	}

	// ---- Windowed form ----
	if (windowsSpec) {
		const windowKeys = Object.keys(windowsSpec);
		if (windowKeys.length === 0) {
			throw new Error('[svelte-realtime] live.aggregate: windows must declare at least one window');
		}
		for (const [name, spec] of Object.entries(windowsSpec)) {
			_validateWindowSpec(name, spec, reducers);
		}

		// The "root" function. It is NOT a stream itself; the per-window
		// streams attached as `__windowStreams` are what the Vite plugin
		// generates client stubs for. Calling the root directly throws --
		// the user's per-window subscribe path is the intended entry.
		const root = function aggregateRoot() {
			throw new Error('[svelte-realtime] Windowed aggregate is not a single stream; subscribe via its per-window children (e.g. `myAggregate.last10min`).');
		};

		/** @type {any} */ (root).__isAggregate = true;
		/** @type {any} */ (root).__isLive = true;
		/** @type {any} */ (root).__aggregateSource = source;
		/** @type {any} */ (root).__aggregateReducers = reducers;
		/** @type {any} */ (root).__aggregateInitState = initState;
		/** @type {any} */ (root).__aggregateBaseTopic = topic;
		/** @type {any} */ (root).__aggregateSnapshot = options?.snapshot || null;
		/** @type {any} */ (root).__aggregateSnapshots = options?.snapshots || null;
		/** @type {any} */ (root).__aggregateDebounce = debounce;
		/** @type {any} */ (root).__aggregateWindows = windowsSpec;
		/** @type {any} */ (root).__aggregateWindowKeys = windowKeys;
		/** @type {any} */ (root).__aggregatePrivacy = privacy;

		// Build per-window stream functions. Each is registered separately
		// via the Vite plugin's per-window registry lines and exposed on
		// the client as `myAggregate.windowName`.
		const windowStreams = {};
		for (const wn of windowKeys) {
			const outputTopic = `${topic}:${wn}`;
			const perWindowInit = async function aggregatePerWindowInit() {
				const entry = _aggregateByTopic.get(topic);
				if (!entry || !entry.windowStates) {
					return _computeAggregateState(initState, reducers);
				}
				if (entry._hydrationPromise) await entry._hydrationPromise;
				const winState = entry.windowStates.get(wn);
				if (!winState) return _computeAggregateState(initState, reducers);
				// With privacy, serve the last gated window value (see aggregateInit).
				if (winState.privacy) return winState._lastWire;
				return _computeWindowState(winState, reducers);
			};
			/** @type {any} */ (perWindowInit).__isStream = true;
			/** @type {any} */ (perWindowInit).__isLive = true;
			/** @type {any} */ (perWindowInit).__isAggregateWindow = true;
			/** @type {any} */ (perWindowInit).__streamTopic = outputTopic;
			/** @type {any} */ (perWindowInit).__streamOptions = { merge: 'set' };
			/** @type {any} */ (perWindowInit).__aggregateRoot = root;
			/** @type {any} */ (perWindowInit).__aggregateWindowName = wn;
			windowStreams[wn] = perWindowInit;
		}
		/** @type {any} */ (root).__windowStreams = windowStreams;

		return root;
	}

	// ---- Single-state form (existing behavior, untouched) ----
	const initFn = async function aggregateInit() {
		const entry = _aggregateByTopic.get(topic);
		if (entry) {
			// Wait for snapshot hydration to finish before returning state
			if (entry._hydrationPromise) await entry._hydrationPromise;
			// With privacy, the initial load must serve the last GATED value
			// (k-anon held / DP-noised), never the live below-k aggregate.
			if (entry.privacy) return entry._lastWire;
			return _computeAggregateState(entry.state, reducers);
		}
		return _computeAggregateState(initState, reducers);
	};

	/** @type {any} */ (initFn).__isAggregate = true;
	/** @type {any} */ (initFn).__isStream = true;
	/** @type {any} */ (initFn).__isLive = true;
	/** @type {any} */ (initFn).__streamTopic = topic;
	/** @type {any} */ (initFn).__streamOptions = { merge: 'set' };
	/** @type {any} */ (initFn).__aggregateSource = source;
	/** @type {any} */ (initFn).__aggregateReducers = reducers;
	/** @type {any} */ (initFn).__aggregateInitState = initState;
	/** @type {any} */ (initFn).__aggregateSnapshot = options?.snapshot || null;
	/** @type {any} */ (initFn).__aggregateDebounce = debounce;
	/** @type {any} */ (initFn).__aggregatePrivacy = privacy;
	return initFn;
};
