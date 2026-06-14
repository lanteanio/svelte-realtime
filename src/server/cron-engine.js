// @ts-check
import { state, cronRegistry, _lazyQueue } from './state.js';
import { _IS_DEV } from './env.js';
import { now as runtimeNow, effectiveTimeZone, setTimer, setIntervalTimer, clearTimer, clearIntervalTimer } from '../shared/runtime.js';
import { _cronDateParts, _cronFieldMatch } from './cron.js';
import { _getCtxHelpers, _buildCtx } from './ctx.js';
import { _ensureWrap } from './reactive.js';
import { _maybeReplayPublish } from './replay-routing.js';
import { _setBus } from './bus.js';
import { _resolveAllLazy, _isLazyResolved } from './lazy.js';

/** @type {ReturnType<typeof setInterval> | null} */
let _cronInterval = null;

/**
 * Sticky-once-set: flips to true when a 6-field schedule (sub-minute
 * resolution) gets registered. Causes `_ensureCronInterval` to use a
 * 1-second tick instead of 60s. Never flips back inside a process
 * lifetime; cleared by `_clearCron` (HMR + tests).
 */
let _cronAt1Hz = false;

/**
 * Set of cron paths whose previous invocation has not yet finished.
 * Single-flight guard: a tick that matches a path already in this set
 * skips with a `cronCount{status:'skipped'}` metric increment instead
 * of running concurrently. Cleared by `_clearCron`.
 * @type {Set<string>}
 */
const _cronRunning = new Set();

/**
 * Process-wide leader gate for cron. When set, every tick consults
 * `_cronLeader()` before invoking any registered job; if it returns
 * falsy, the tick exits without firing. `null` means "no gate" - every
 * worker fires every job (the single-process default; correct behavior
 * for non-clustered deployments and dev).
 *
 * Configured via `configureCron({ leader })`. The canonical
 * cluster-mode implementation lives in
 * `svelte-adapter-uws-extensions/redis/leader` (Redis-lease-based
 * elect-and-renew); svelte-realtime stays cluster-agnostic here so it
 * does not pull in a Redis dependency.
 *
 * @type {(() => boolean) | null}
 */
let _cronLeader = null;

/**
 * One-shot flag for the "configureCron leader without bus" warning.
 * Setting `leader` declares cluster intent; not also wiring a bus
 * means leader-only cron ticks fan out only on the leader's worker,
 * which is almost certainly a config bug. Reset by `_clearCron` so
 * HMR / tests get a fresh slate.
 */
let _cronClusterWarnFired = false;

/**
 * One-shot flag for the "cron fired but no platform captured" warning.
 * Without dedup, a 6-field schedule + an idle server produces a per-second
 * stream of identical warnings until the first WS connection (or, post
 * adapter `init` hook wiring, the boot of the first worker). Reset by
 * `_clearCron` so HMR / tests get a fresh slate. Reset to false the
 * moment a platform is captured, so a subsequent platform-loss (today
 * impossible, but defensive) re-arms the warning once.
 */
let _cronPlatformWarnFired = false;

/** @deprecated Use onError() instead. */
export function onCronError(handler) {
	state.serverErrorHandler = handler;
}

/**
 * Register a cron job. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerCron(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'cron', path, loader: fn });
		_ensureCronInterval();
		return;
	}
	const parsed = /** @type {any} */ (fn).__cronParsed;
	const topic = /** @type {any} */ (fn).__cronTopic;
	if (!parsed || !topic) return;
	cronRegistry.set(path, { schedule: parsed, fn, topic });
	// 6-field schedule means seconds-precision firing is required.
	// Upgrade the tick to 1 Hz once any such schedule registers.
	if (parsed.length === 6) _upgradeCronTo1Hz();
	_ensureCronInterval();
}

/**
 * Capture a platform reference for cron jobs.
 *
 * **Recommended call site (svelte-adapter-uws >= 0.5.0-next.15):** the
 * `init({ platform })` hook in `hooks.ws.js`. The adapter fires `init`
 * exactly once per worker after the listen socket is bound and before
 * any `upgrade` / `open` / `message` hook can run, so the cron tick has
 * a platform from the very first scheduled fire and no
 * "fired but no platform captured" warning is possible.
 *
 * **Legacy / fallback call site:** the `open(ws, platform)` hook. Works
 * but the platform is only captured on the first WebSocket connection,
 * so cron ticks during the boot-to-first-connect window are no-ops and
 * surface a single (deduped) warning. Migrate to `init` when you bump
 * the adapter to next.15+.
 *
 * In clustered deployments (CLUSTER_MODE=reuseport on Linux, or
 * acceptor mode on Windows/macOS / multi-replica Docker), `init` fires
 * once per worker - so every worker captures its own platform and
 * every worker's cron tick fires every job in parallel by default. To
 * get single-fire semantics across the cluster, also wire a leader gate
 * via `configureCron({ leader })` (see that function's docs for
 * the canonical extensions-package implementation).
 *
 * @param {import('svelte-adapter-uws').Platform} platform
 *
 * @example
 * ```js
 * // src/hooks.ws.js (adapter next.15+)
 * import { setCronPlatform, pushHooks, message, upgrade } from 'svelte-realtime/server';
 *
 * export { upgrade, message };
 * export const open = pushHooks.open;
 * export const close = pushHooks.close;
 *
 * export function init({ platform }) {
 *     setCronPlatform(platform);
 * }
 * ```
 */
export function setCronPlatform(platform) {
	state.cronPlatform = platform;
	// Re-arm the dedup so a subsequent platform-loss (defensive only --
	// platform never goes null in practice) gets one fresh warning.
	_cronPlatformWarnFired = false;
	// Install the framework's publish wrap here too: pure-cron apps that
	// never call `_activateDerived` (no reactive primitives wired) still
	// need cluster routing when a bus is configured. The wrap is idempotent
	// via `_activatedPlatforms`, so when `realtime().init` calls both
	// `setCronPlatform` and `_activateDerived` the second call is a no-op.
	if (platform) _ensureWrap(platform);
}

/**
 * Configure cron behavior across the cluster.
 *
 * Currently exposes a single field, `leader`, which gates whether this
 * worker fires its registered cron jobs. Without a leader configured,
 * every worker fires every job on every matching tick - the correct
 * single-process default, and the only sane default for dev. In
 * clustered deployments (whether SO_REUSEPORT on Linux with N kernel
 * workers per replica, or N replicas with internal acceptor-mode
 * cluster on Windows / macOS, or both compounded) this is almost never
 * what you want for "send the daily summary email at 9am" - you want
 * exactly one fire across the cluster, regardless of how many JS heaps
 * are ticking.
 *
 * The `leader` function is consulted at the top of every tick. If it
 * returns falsy, the tick exits without firing any job. The expected
 * call shape is synchronous and very cheap (a boolean read from a
 * cached state); the canonical implementation is in
 * `svelte-adapter-uws-extensions/redis/leader`, which maintains a
 * background Redis SETNX lease (acquire-and-renew) and exposes the
 * cached "am I the leader right now" state as a synchronous getter.
 * svelte-realtime intentionally does not bundle the leader
 * implementation - the cluster transport (Redis or otherwise) is the
 * extensions package's domain, and pulling Redis into the realtime
 * layer would force a dependency on every consumer including
 * single-process apps that do not need it.
 *
 * Pass `null` (in place of the whole config object) to clear the
 * leader and revert to "every worker fires" behavior.
 *
 * @param {{ leader?: (() => boolean) | null } | null} config
 *
 * @example
 * ```js
 * // src/hooks.ws.js (adapter next.15+, clustered deployment)
 * import { setCronPlatform, configureCron } from 'svelte-realtime/server';
 * import { createLeader } from 'svelte-adapter-uws-extensions/redis/leader';
 *
 * const leader = createLeader(redis);
 *
 * export function init({ platform }) {
 *     setCronPlatform(platform);
 *     configureCron({ leader: leader.isLeader });
 * }
 *
 * export async function shutdown() {
 *     // Best-effort lease release so a sibling can take over within
 *     // renewMs (default 10s) instead of waiting for the full lease.
 *     await leader.stop();
 * }
 * ```
 *
 * @example
 * ```js
 * // Tests / single-process: no configureCron call needed; the default
 * // "fires on every worker" is exactly right.
 * ```
 */
export function configureCron(config) {
	if (config === null) {
		_cronLeader = null;
		_setBus(null);
		return;
	}
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] configureCron: config must be an object or null');
	}
	if (config.leader === undefined && config.bus === undefined) {
		throw new Error('[svelte-realtime] configureCron: config must include at least one of leader or bus');
	}
	if (config.leader !== undefined) {
		if (config.leader === null) {
			_cronLeader = null;
		} else if (typeof config.leader !== 'function') {
			throw new Error('[svelte-realtime] configureCron: leader must be a function or null');
		} else {
			_cronLeader = config.leader;
		}
	}
	if (config.bus !== undefined) {
		// Routes through `_setBus` so the canonical `state.bus` (consulted by
		// the reactive wrap, the RPC auto-wrap, and the top-level
		// `publish()` helper) stays in lockstep with the legacy
		// `state.cronBus` alias - one declaration of cluster intent covers
		// every framework seam, not just cron.
		if (config.bus !== null && (typeof config.bus !== 'object' || typeof config.bus.wrap !== 'function')) {
			throw new Error('[svelte-realtime] configureCron: bus must expose a .wrap(platform) method or be null');
		}
		_setBus(config.bus);
	}
	// Diagnostic: cluster intent (leader) without cluster fan-out (bus)
	// is almost always a misconfig. Leader-only cron ticks publish on the
	// leader worker only - subscribers on non-leader instances see
	// nothing. The user typically wants both wired together. Warn once
	// per process so the same hot-reload cycle doesn't spam.
	if (_IS_DEV && _cronLeader !== null && state.cronBus === null && !_cronClusterWarnFired) {
		console.warn(
			"[svelte-realtime] configureCron({ leader }) was set without a `bus`. " +
			"Leader-only cron ticks publish on the elected worker only - " +
			"subscribers on other cluster instances will not see them. " +
			"Wire `bus` from svelte-adapter-uws-extensions/redis/pubsub or " +
			"sharded-pubsub:\n" +
			"  configureCron({ leader: leader.isLeader, bus });\n" +
			"  See: https://svti.me/cluster-cron"
		);
		_cronClusterWarnFired = true;
	}
}

/** @type {ReturnType<typeof setTimeout> | null} */
let _cronStartupTimer = null;

export function _ensureCronInterval() {
	if (_cronInterval) return;
	// Set sentinel immediately to prevent duplicate timers from concurrent calls
	_cronInterval = /** @type {any} */ (-1);
	_cronInterval = setIntervalTimer(_tickCron, _cronAt1Hz ? 1000 : 60000);
	// Run an initial tick after a short delay to catch jobs on startup
	_cronStartupTimer = setTimer(_tickCron, 1000);
}

/**
 * Switch the cron interval to 1 Hz (called when the first sub-minute
 * job is registered). Sticky: subsequent calls are no-ops, and the
 * tick stays at 1 Hz for the rest of the process lifetime even if all
 * 6-field jobs are torn down. Cleared by `_clearCron` for HMR.
 */
function _upgradeCronTo1Hz() {
	if (_cronAt1Hz) return;
	_cronAt1Hz = true;
	if (_cronInterval && _cronInterval !== /** @type {any} */ (-1)) {
		clearIntervalTimer(_cronInterval);
		_cronInterval = setIntervalTimer(_tickCron, 1000);
	}
}

/**
 * Clear all cron timers. Called during HMR to prevent orphan intervals,
 * and from afterEach in tests. Also resets the sticky-1Hz flag, the
 * single-flight set, and the platform-missing warn-once flag so the
 * next registration round starts fresh.
 *
 * `state.cronPlatform` and `_cronLeader` are intentionally NOT cleared: both
 * are user-provided refs captured once per process lifetime (typically
 * from the adapter's `init` hook), and clearing them would force every
 * HMR cycle to re-acquire them. Tests that need to swap a leader can
 * call `configureCron({ leader: null })` between cases.
 */
export function _clearCron() {
	if (_cronInterval) {
		clearIntervalTimer(_cronInterval);
		_cronInterval = null;
	}
	if (_cronStartupTimer) {
		clearTimer(_cronStartupTimer);
		_cronStartupTimer = null;
	}
	cronRegistry.clear();
	_cronAt1Hz = false;
	_cronRunning.clear();
	_cronPlatformWarnFired = false;
	_cronClusterWarnFired = false;
}

export async function _tickCron() {
	if (!_isLazyResolved()) await _resolveAllLazy();

	// Cluster-mode leader gate. Default (no leader configured) is "every
	// worker fires" - correct for single-process and dev. With a leader
	// wired via `configureCron({ leader })` (canonical implementation
	// in svelte-adapter-uws-extensions/redis/leader), only the
	// elected worker proceeds to evaluate the per-job schedule match.
	// The leader call must be cheap and synchronous; the extensions
	// implementation maintains the lease in the background and exposes
	// the "am I leader right now" state as a cached boolean read.
	if (_cronLeader !== null) {
		let isLeader;
		try {
			isLeader = _cronLeader();
		} catch (err) {
			// A throwing leader fn is a configuration bug; fail closed
			// (do not fire) and surface the cause in dev. Fail-closed is
			// the safe default: better to skip a tick than to double-fire
			// a job because the leader-election machinery is broken.
			if (_IS_DEV) {
				console.error('[svelte-realtime] configureCron leader function threw; skipping tick:', err, '\n  See: https://svti.me/cron');
			}
			if (state.metricsInstruments) state.metricsInstruments.cronCount.inc({ path: '*', status: 'leader-error' });
			return;
		}
		if (!isLeader) {
			if (state.metricsInstruments) state.metricsInstruments.cronCount.inc({ path: '*', status: 'not-leader' });
			return;
		}
	}

	// Extract the wall-clock date parts the schedule matches against by
	// formatting the runtime epoch-ms through Intl in the effective time zone,
	// without constructing a Date. The effective zone is the system zone by
	// default (preserving the historical local-time cron behavior); a seeded
	// simulation harness pins it (e.g. 'UTC') so the same epoch-ms always
	// yields the same parts. The schedule math below is unchanged - only the
	// parts extraction is now Intl + time-zone based.
	const { second, minute, hour, day, month, weekday } = _cronDateParts(
		runtimeNow(),
		effectiveTimeZone() || undefined
	);

	for (const [path, entry] of cronRegistry) {
		const schedule = entry.schedule;
		const isSixField = schedule.length === 6;

		// 5-field schedules at 1 Hz tick: only fire at second :00 of the
		// matching minute, otherwise they would re-fire 60 times during
		// any matching minute. At the 60s tick this branch is skipped --
		// the tick spacing already enforces once-per-minute granularity.
		if (!isSixField && _cronAt1Hz && second !== 0) continue;

		let sf, mf, hf, df, monthf, wf;
		if (isSixField) {
			[sf, mf, hf, df, monthf, wf] = schedule;
			if (!_cronFieldMatch(sf, second)) continue;
		} else {
			[mf, hf, df, monthf, wf] = schedule;
		}
		if (!_cronFieldMatch(mf, minute)) continue;
		if (!_cronFieldMatch(hf, hour)) continue;
		if (!_cronFieldMatch(df, day)) continue;
		if (!_cronFieldMatch(monthf, month)) continue;
		if (!_cronFieldMatch(wf, weekday)) continue;

		// Single-flight: a tick that matches a job whose previous run is
		// still in flight skips with a 'skipped' metric label instead of
		// invoking it again. Surfaces overlap to ops without breaking the
		// invariant that one cron path runs at most once concurrently.
		if (_cronRunning.has(path)) {
			if (state.metricsInstruments) state.metricsInstruments.cronCount.inc({ path, status: 'skipped' });
			continue;
		}
		_cronRunning.add(path);

		// Match - run the job
		(async () => {
			try {
				if (!state.cronPlatform) {
					// Warn at most once per process lifetime. Without dedup,
					// a 6-field schedule + idle server emits this line every
					// second across the boot-to-first-connect window,
					// drowning out other diagnostics. Reset by `_clearCron`
					// (HMR / tests) and by `setCronPlatform` so a fresh
					// capture re-arms the warning if platform later goes
					// missing again (defensive only - platform is sticky
					// across HMR by design, but we don't want to assume).
					if (_IS_DEV && !_cronPlatformWarnFired) {
						console.warn(`[svelte-realtime] Cron registered but no platform captured. Wire setCronPlatform(platform) from your hooks.ws.js init({ platform }) hook (svelte-adapter-uws >= 0.5.0-next.15) or from your open(ws, platform) hook on older adapters.\n  See: https://svti.me/cron`);
						_cronPlatformWarnFired = true;
					}
					return;
				}
				// Cluster fan-out is the framework's publish wrap's job
				// now (one wrap site for the whole framework, installed
				// by `_ensureWrap` from `setCronPlatform`). The cron tick
				// uses the captured `state.cronPlatform` directly - its
				// `publish` is `derivedPublish`, which consults the
				// process-wide bus at publish time. No outer `bus.wrap(...)`
				// here, which eliminates the 0.5.6 double-relay class of
				// bugs by construction.
				const cronPub = state.cronPlatform;
				const _h = _getCtxHelpers(cronPub);
				const ctx = _buildCtx(null, null, cronPub, _h, null);
				const result = await entry.fn(ctx);
				if (result !== undefined) {
					// Same auto-replay routing as ctx.publish: cron-published
					// events to a replay-eligible topic flow through
					// `platform.replay.publish` so the buffer captures them
					// and reconnecting clients can replay missed ticks.
					if (!_maybeReplayPublish(cronPub, entry.topic, 'set', result)) {
						cronPub.publish(entry.topic, 'set', result);
					}
				}
				if (state.metricsInstruments) state.metricsInstruments.cronCount.inc({ path, status: 'ok' });
			} catch (err) {
				if (state.metricsInstruments) {
					state.metricsInstruments.cronCount.inc({ path, status: 'error' });
					state.metricsInstruments.cronErrors.inc({ path });
				}
				if (state.serverErrorHandler) {
					state.serverErrorHandler(path, err);
				} else if (_IS_DEV) {
					console.error(`[svelte-realtime] Cron '${path}' error:`, err, '\n  See: https://svti.me/cron');
				}
			} finally {
				_cronRunning.delete(path);
			}
		})();
	}
}

// Accessors for the staying reactive leader gate (installReactive) and the HMR
// snapshot (_prepareHmr) - both stay in server.js and read these through here.
export function _getCronLeader() { return _cronLeader; }
export function _cronTimerActive() { return _cronInterval !== null; }
