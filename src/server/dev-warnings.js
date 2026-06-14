// @ts-check
import { setTimer, setIntervalTimer, clearTimer, clearIntervalTimer } from '../shared/runtime.js';
import { _IS_DEV } from './env.js';
import { state, _silentTopicWatch, _topicCoalesce, _topicVolatile } from './state.js';

/**
 * Per-process state for the dev-mode silent-topic warning. Arms a one-shot
 * timer on the first subscribe to a topic; if no event arrives within
 * `thresholdMs`, logs a warning suggesting common causes (missing pg_notify
 * trigger, missing handler-side publish, intentionally low-traffic topic).
 *
 * Hard-gated to development. Production-side cost: one boolean check on
 * the publish hot path, constant-folded out by Vite/Rollup when
 * `process.env.NODE_ENV === 'production'`.
 *
 * Shape mirrors `_topicStaleWatch` (per-topic timer + flags); the watchdog
 * fires once per topic per process and dedupes via `_silentTopicWarned`
 * so re-subscribes after a warn don't re-fire.
 */
const _silentTopicConfig = {
	enabled: true,
	thresholdMs: 30000,
	/** @type {Set<string>} */
	suppress: new Set()
};

/** @type {Set<string>} Topics already warned about; prevents re-warning across re-subscribe cycles. */
const _silentTopicWarned = new Set();

/**
 * Arm the silent-topic watchdog for a topic on its first subscriber.
 * Skips system topics (`__`-prefixed: `__realtime`, `__signal:*`, etc.)
 * which are intentionally quiet until something publishes. Skips topics
 * the user has explicitly suppressed and topics already warned about.
 * Idempotent per topic; second-sub-on-same-topic is a no-op.
 *
 * @param {string} topic
 */
export function _armSilentTopicWatch(topic) {
	if (!_IS_DEV) return;
	if (!_silentTopicConfig.enabled) return;
	if (_silentTopicWatch.has(topic)) return;
	if (_silentTopicWarned.has(topic)) return;
	if (_silentTopicConfig.suppress.has(topic)) return;
	if (topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) return;
	const entry = {
		sawEvent: false,
		timerId: setTimer(() => {
			const e = _silentTopicWatch.get(topic);
			if (!e || e.sawEvent) return;
			if (_silentTopicWarned.size >= state.silentTopicWarnDedupMax && !_silentTopicWarned.has(topic)) {
				const oldest = _silentTopicWarned.values().next().value;
				if (oldest !== undefined) _silentTopicWarned.delete(oldest);
			}
			_silentTopicWarned.add(topic);
			console.warn(
				"[svelte-realtime] Topic '" + topic + "' has subscribers but no events arrived within " +
				_silentTopicConfig.thresholdMs + "ms.\n" +
				"  Common causes:\n" +
				"    - missing pg_notify trigger on the underlying table\n" +
				"    - no ctx.publish() call in the relevant handler\n" +
				"    - intentionally low-traffic topic (extend threshold or suppress)\n" +
				"  Configure: live.silentTopicWarning({ thresholdMs: 60000 })\n" +
				"  Suppress:  live.silentTopicWarning({ suppress: ['" + topic + "'] })\n" +
				"  Disable:   live.silentTopicWarning(false)\n" +
				"  See: https://svti.me/silent-topic"
			);
		}, _silentTopicConfig.thresholdMs)
	};
	if (typeof (/** @type {any} */ (entry.timerId).unref) === 'function') {
		/** @type {any} */ (entry.timerId).unref();
	}
	_silentTopicWatch.set(topic, entry);
}

/**
 * Mark a topic as having seen an event. Called from the publish-helper
 * closure on every publish. Once an event arrives, the watchdog is
 * disarmed for that topic for the lifetime of the process (the warning
 * never fires for a topic that has been live).
 *
 * @param {string} topic
 */
export function _observeSilentTopicPublish(topic) {
	const entry = _silentTopicWatch.get(topic);
	if (!entry) return;
	entry.sawEvent = true;
	clearTimer(entry.timerId);
	_silentTopicWatch.delete(topic);
}

/**
 * Clear the silent-topic watchdog when the last subscriber leaves the
 * topic. Mirrors `_unregisterStaleWatch`. No-op when no watchdog exists.
 *
 * @param {string} topic
 */
export function _disarmSilentTopicWatch(topic) {
	const entry = _silentTopicWatch.get(topic);
	if (!entry) return;
	clearTimer(entry.timerId);
	_silentTopicWatch.delete(topic);
}

/** Reset the silent-topic watchdog state. Tests only. @internal */
export function _resetSilentTopicWarning() {
	for (const entry of _silentTopicWatch.values()) clearTimer(entry.timerId);
	_silentTopicWatch.clear();
	_silentTopicWarned.clear();
	_silentTopicConfig.enabled = true;
	_silentTopicConfig.thresholdMs = 30000;
	_silentTopicConfig.suppress.clear();
}

/**
 * Per-process state for the dev-mode publish-rate warning. Sampler is lazy:
 * activated on the first ctx-helpers cache miss per platform, runs at the
 * configured interval, reads `platform.pressure.topPublishers` (already
 * computed by the adapter sampler), and emits one warn per topic per
 * process when a topic is over threshold. Production has zero cost --
 * `_IS_DEV` is constant-folded so the activation branch is dead code.
 */
const _publishRateConfig = {
	enabled: true,
	threshold: 200,
	intervalMs: 5000
};
/** @type {Set<string>} */
const _publishRateWarned = new Set();
/** @type {WeakMap<any, ReturnType<typeof setInterval>>} */
const _publishRateSamplers = new WeakMap();
/**
 * Bumped by `_resetPublishRateWarning` and by `live.publishRateWarning(false)`.
 * Each sampler captures its activation-time epoch and self-clears on the next
 * fire when the epoch no longer matches. Pattern used in place of the prior
 * strong-reference `Set<platform>` because that Set held every dev-mode
 * platform alive across the process lifetime, defeating the WeakMap above and
 * leaking the platform + all captured helpers/closures on every per-call
 * wrap pattern (e.g. cron tick wrapping a fresh `bus.wrap(platform)` per fire).
 */
let _publishRateEpoch = 0;

/**
 * Activate the dev-mode publish-rate warning sampler for one platform.
 * Idempotent per platform identity. Safe to call from any code path that
 * sees a platform reference for the first time. Production has zero cost
 * (returns immediately on the `_IS_DEV` gate). Exported with an
 * underscore prefix so tests can drive activation deterministically
 * without going through the async RPC path.
 *
 * The sampler closure must NOT strongly capture `platform`. Node's timer
 * queue holds the `setInterval` Timer alive until clearInterval fires; if
 * the closure captured `platform` directly, every platform ever passed in
 * would stay reachable forever, leaking the entire helpers+closures graph.
 * The `WeakRef` wrapper here breaks that retention: on each tick the
 * sampler derefs, and a null deref (platform GC'd elsewhere) self-clears
 * the timer. Net effect: at most one stale tick after platform GC, then
 * the entry vanishes.
 *
 * @param {any} platform
 */
export function _activatePublishRateWarning(platform) {
	if (!_IS_DEV) return;
	if (!_publishRateConfig.enabled) return;
	if (_publishRateSamplers.has(platform)) return;
	if (typeof platform?.pressure !== 'object' || platform.pressure === null) return;
	const platformRef = new WeakRef(platform);
	const epoch = _publishRateEpoch;
	const sampler = setIntervalTimer(() => {
		// Self-clear on disable / reset / platform-GC. Any of the three
		// makes the sampler stale; clearInterval here lets Node drop the
		// Timer from the queue on the next event-loop turn.
		if (!_publishRateConfig.enabled || epoch !== _publishRateEpoch) {
			clearIntervalTimer(sampler);
			return;
		}
		const p = platformRef.deref();
		if (!p) {
			clearIntervalTimer(sampler);
			return;
		}
		const top = p.pressure?.topPublishers;
		if (!Array.isArray(top)) return;
		for (const entry of top) {
			if (!entry || typeof entry.topic !== 'string') continue;
			if (entry.messagesPerSec < _publishRateConfig.threshold) continue;
			if (_publishRateWarned.has(entry.topic)) continue;
			if (_publishRateWarned.size >= state.publishRateWarnDedupMax) {
				const oldest = _publishRateWarned.values().next().value;
				if (oldest !== undefined) _publishRateWarned.delete(oldest);
			}
			_publishRateWarned.add(entry.topic);
			// Suppress the hint when the user has already chosen one of the
			// two natural mitigations for this topic. Both registries are
			// populated on subscribe; if either has the topic, the user knows
			// it's high-frequency and picked their tool.
			if (_topicCoalesce.has(entry.topic) || _topicVolatile.has(entry.topic)) continue;
			console.warn(
				`[svelte-realtime] Topic '${entry.topic}' is publishing ` +
				`${Math.round(entry.messagesPerSec)} events/sec.\n` +
				`  For high-frequency streams, consider one of:\n` +
				`    live.stream(topic, loader, { coalesceBy: (data) => data.userId })  // latest-value-wins, queued per subscriber\n` +
				`    live.stream(topic, loader, { volatile: true })                     // drop on backpressure, best-effort\n` +
				`  See: https://svti.me/highfreq`
			);
		}
	}, _publishRateConfig.intervalMs);
	if (typeof sampler.unref === 'function') sampler.unref();
	_publishRateSamplers.set(platform, sampler);
}

/**
 * Reset the dev-mode publish-rate warning state. Tests only. Clears the
 * one-shot warned set and bumps the per-process epoch so every existing
 * sampler self-clears on its next fire. Stale samplers stop within one
 * `intervalMs` of the reset (default 5s); a same-platform re-activation
 * after reset gets a fresh sampler because the old WeakMap entry's
 * sampler will self-clear on its next tick and never write state again.
 *
 * If a test needs synchronous teardown (e.g. to assert no extra warns
 * fire after reset within the same tick), call this AND assert that
 * `_publishRateConfig.enabled` is false; samplers short-circuit on the
 * disabled flag without doing any work.
 */
export function _resetPublishRateWarning() {
	_publishRateWarned.clear();
	_publishRateEpoch++;
}

/**
 * Configure the dev-mode publish-rate warning. Pass `false` to disable
 * entirely; pass `{ threshold, intervalMs }` to override the defaults
 * (200 events/sec, sampled every 5000 ms). Pass `true` (or omit args
 * entirely; default is on) to re-enable with current settings.
 *
 * The warning fires once per topic per process when a topic's measured
 * publish rate (read from `platform.pressure.topPublishers`) crosses the
 * threshold within a sample window. Hard-gated to development builds --
 * production has zero cost regardless of configuration.
 *
 * @example
 * // Disable entirely (e.g. CLI tooling that uses live() without a UI):
 * live.publishRateWarning(false);
 *
 * @example
 * // Lower the bar for noisier insight:
 * live.publishRateWarning({ threshold: 50 });
 *
 * @example
 * // Sample more frequently (5s default is conservative):
 * live.publishRateWarning({ threshold: 200, intervalMs: 1000 });
 *
 * @param {false | true | { threshold?: number, intervalMs?: number }} [config]
 */
const _publishRateWarningImpl = function publishRateWarning(config) {
	if (config === false) {
		_publishRateConfig.enabled = false;
		// Existing samplers self-clear on their next fire via the
		// `_publishRateConfig.enabled` check at the top of the callback.
		// Bumping the epoch is belt-and-suspenders: a sampler whose
		// callback is in flight when the flag flips still sees the
		// epoch mismatch on its NEXT scheduled fire. Worst case is one
		// stale interval (default 5s) before the timer goes idle.
		_publishRateEpoch++;
		return;
	}
	if (config === undefined || config === true) {
		_publishRateConfig.enabled = true;
		return;
	}
	if (typeof config !== 'object' || config === null) {
		throw new Error('[svelte-realtime] live.publishRateWarning: config must be true, false, or an object');
	}
	if (config.threshold !== undefined) {
		if (typeof config.threshold !== 'number' || config.threshold <= 0 || !Number.isFinite(config.threshold)) {
			throw new Error('[svelte-realtime] live.publishRateWarning: threshold must be a positive finite number (events/sec)');
		}
		_publishRateConfig.threshold = config.threshold;
	}
	if (config.intervalMs !== undefined) {
		if (typeof config.intervalMs !== 'number' || config.intervalMs <= 0 || !Number.isFinite(config.intervalMs)) {
			throw new Error('[svelte-realtime] live.publishRateWarning: intervalMs must be a positive finite number (ms)');
		}
		_publishRateConfig.intervalMs = config.intervalMs;
	}
	_publishRateConfig.enabled = true;
};

/**
 * Configure the dev-mode silent-topic warning. When a stream subscribes to a
 * topic and no events arrive within `thresholdMs`, log a one-shot warning
 * naming the topic and the common causes (missing pg_notify trigger,
 * missing handler-side `ctx.publish()`, intentionally low-traffic topic).
 *
 * Pass `false` to disable; pass `true` (or omit args) to re-enable with
 * current settings; pass `{ thresholdMs?, suppress? }` to override.
 * `suppress` is an array of topic strings the warning will skip
 * unconditionally (use for topics you know are intentionally quiet).
 *
 * Topics starting with `__` (system topics: `__realtime`, `__signal:*`,
 * `__custom`) are always skipped automatically; you don't need to add
 * them to `suppress`.
 *
 * Hard-gated to development. Production has zero cost regardless of
 * configuration: the activation gate (`_IS_DEV`) is constant-folded by
 * Vite/Rollup so the watchdog state is never touched.
 *
 * @example
 * // Disable globally (e.g. in CI where stream emptiness is expected):
 * live.silentTopicWarning(false);
 *
 * @example
 * // Lower the bar for noisier insight:
 * live.silentTopicWarning({ thresholdMs: 5000 });
 *
 * @example
 * // Suppress per-topic for known-quiet streams:
 * live.silentTopicWarning({ suppress: ['admin:audit', 'cron:reports'] });
 *
 * @param {false | true | { thresholdMs?: number, suppress?: string[] }} [config]
 */
const _silentTopicWarningImpl = function silentTopicWarning(config) {
	if (config === false) {
		_silentTopicConfig.enabled = false;
		// Disable takes effect immediately: clear any armed timers.
		for (const entry of _silentTopicWatch.values()) clearTimer(entry.timerId);
		_silentTopicWatch.clear();
		return;
	}
	if (config === undefined || config === true) {
		_silentTopicConfig.enabled = true;
		return;
	}
	if (typeof config !== 'object' || config === null) {
		throw new Error('[svelte-realtime] live.silentTopicWarning: config must be true, false, or an object');
	}
	if (config.thresholdMs !== undefined) {
		if (typeof config.thresholdMs !== 'number' || config.thresholdMs <= 0 || !Number.isFinite(config.thresholdMs)) {
			throw new Error('[svelte-realtime] live.silentTopicWarning: thresholdMs must be a positive finite number');
		}
		_silentTopicConfig.thresholdMs = config.thresholdMs;
	}
	if (config.suppress !== undefined) {
		if (!Array.isArray(config.suppress)) {
			throw new Error('[svelte-realtime] live.silentTopicWarning: suppress must be an array of topic strings');
		}
		for (const topic of config.suppress) {
			if (typeof topic !== 'string') {
				throw new Error('[svelte-realtime] live.silentTopicWarning: suppress entries must be strings');
			}
		}
		_silentTopicConfig.suppress = new Set(config.suppress);
	}
	_silentTopicConfig.enabled = true;
};

// Seam: attach the two dev-warning augmentors onto the live() factory, which
// stays in server.js. Mirrors installRateLimit(live)/installAdmission(live).
export function installDevWarnings(live) {
	live.publishRateWarning = _publishRateWarningImpl;
	live.silentTopicWarning = _silentTopicWarningImpl;
}
