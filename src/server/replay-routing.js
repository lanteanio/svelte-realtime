// @ts-check
import { _IS_DEV } from './env.js';

/**
 * Topics declared with `live.stream(..., { replay: true })`. Populated at
 * declaration time for static topics and at first-subscribe time for
 * dynamic-topic factories (when the topic resolves). When a publish to one
 * of these topics happens (from `ctx.publish`, cron auto-publish, derived /
 * aggregate, anywhere), the framework auto-routes through
 * `platform.replay.publish(...)` so the buffer captures it for gap-fill on
 * resume -- regardless of which seam (RPC / cron / etc.) the publisher
 * sits on. Pre-fix, only publishes that flowed through a user-managed
 * `wrapWithReplay` proxy reached the buffer; cron-published events bypassed
 * it silently because the cron platform was captured separately.
 *
 * @type {Set<string>}
 */
const _replayEligibleTopics = new Set();

/**
 * Dev-warn dedup for "stream declared replay: true but the adapter does
 * not expose `platform.replay`" misconfigurations. Per-topic so each
 * misconfigured topic surfaces once; the warning includes the install
 * pointer for the replay extension. Cleared by `_resetReplayRouting()`
 * for tests.
 *
 * @type {Set<string>}
 */
const _replayMissingWarned = new Set();

/**
 * Topics whose replay eligibility is an IMPLICIT framework default rather than
 * a user opt-in -- currently a `live.flag`'s default single-entry buffer. The
 * topic still routes to `platform.replay` when the extension is installed, but
 * the missing-extension dev warn is suppressed for these: the user never asked
 * for replay, so a single-process flag app (which loses nothing) should not be
 * told to install an extension. A flag declared with an EXPLICIT `replay` is a
 * real opt-in and is NOT marked implicit, so it still warns. Mirrors the
 * dynamic room-owner `__implicitReplay` gate in `dispatch.js`. Cleared by
 * `_resetReplayRouting()`.
 *
 * @type {Set<string>}
 */
const _implicitReplayTopics = new Set();

/**
 * Public well-known marker: a user-managed platform proxy that already
 * routes replay-eligible publishes through `platform.replay.publish(...)`
 * itself can opt out of the framework's auto-routing by setting this
 * symbol-keyed property to `true`. Without the marker, the framework's
 * `_publish` would call `platform.replay.publish(platform, ...)`, which
 * internally calls `platform.publish(topic, event, data)` -- the user
 * proxy's intercept would then call `replay.publish(target, ...)` again,
 * doubling the Redis write. The marker lets the framework defer to the
 * user proxy in that case.
 *
 * Most users should drop their bespoke `wrapWithReplay` proxy and let the
 * framework own routing; the marker is a back-compat escape hatch.
 */
export const WRAPPED_FOR_REPLAY = Symbol.for('svelte-realtime.wrapped-for-replay');

/**
 * Register a topic as replay-eligible. Called from `live.stream` declaration
 * for static topics, and from `_executeStreamRpc` for dynamic topics on first
 * subscribe. Idempotent; a topic registered twice stays in the set once.
 *
 * @param {string} topic
 * @param {boolean} [implicit] - true when the topic's replay is a framework
 *   default (e.g. a flag's single-entry buffer) rather than a user opt-in;
 *   suppresses the missing-extension dev warn while still routing to the buffer.
 */
export function _registerReplayTopic(topic, implicit) {
	if (typeof topic === 'string' && topic.length > 0) {
		_replayEligibleTopics.add(topic);
		if (implicit) _implicitReplayTopics.add(topic);
	}
}

/**
 * Replay-route a publish through `platform.replay.publish(...)` when the
 * topic is in the replay-eligible registry AND the platform exposes a
 * `replay` surface. Returns `true` when the publish was routed (caller
 * should NOT fall back to `platform.publish` -- replay.publish handles the
 * local broadcast internally) and `false` when it was not (caller should
 * call its own publish path: bare `platform.publish`, batched, or
 * coalesced).
 *
 * Skips routing when:
 * - The topic is not registered as replay-eligible.
 * - The adapter exposes no `platform.replay` (replay extension not
 *   installed). A one-time dev warn fires per topic so the misconfig is
 *   visible during development.
 * - The platform is marked `[WRAPPED_FOR_REPLAY] = true` (a user-managed
 *   proxy is already routing replay; framework defers).
 *
 * Failures inside `replay.publish` are logged in dev and otherwise
 * swallowed -- the local broadcast still happens via the extension's own
 * fallback, and we don't want a Redis hiccup to crash the publisher.
 *
 * @param {any} platform
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @returns {boolean} true if routed through replay, false if caller should fall back
 */
export function _maybeReplayPublish(platform, topic, event, data) {
	if (!_replayEligibleTopics.has(topic)) return false;
	const replay = platform && /** @type {any} */ (platform).replay;
	if (!replay || typeof replay.publish !== 'function') {
		if (_IS_DEV && !_replayMissingWarned.has(topic) && !_implicitReplayTopics.has(topic)) {
			_replayMissingWarned.add(topic);
			console.warn(
				"[svelte-realtime] live.stream('" + topic + "', ..., { replay: true }) is declared but " +
				"the adapter exposes no `platform.replay` -- the bounded replay buffer is not engaged " +
				"and clients will not receive missed events on resume. Install the replay extension " +
				"(svelte-adapter-uws-extensions/redis/replay or postgres/replay) and wire it via " +
				"`platform.replay = createReplay(redisClient)` so `platform.replay` is exposed. " +
				"Warned once per topic per session."
			);
		}
		return false;
	}
	if (/** @type {any} */ (platform)[WRAPPED_FOR_REPLAY]) return false;
	try {
		const ret = replay.publish(platform, topic, event, data);
		if (ret && typeof ret.then === 'function') {
			ret.catch((err) => {
				if (_IS_DEV) {
					console.warn(
						"[svelte-realtime] replay.publish('" + topic + "') failed:",
						err
					);
				}
			});
		}
	} catch (err) {
		if (_IS_DEV) {
			console.warn(
				"[svelte-realtime] replay.publish('" + topic + "') threw synchronously:",
				err
			);
		}
		// On sync throw the local broadcast didn't happen; fall back to
		// platform.publish so subscribers still receive the event live.
		return false;
	}
	return true;
}

/**
 * Reset replay-routing state. Tests only.
 * @internal
 */
export function _resetReplayRouting() {
	_replayEligibleTopics.clear();
	_replayMissingWarned.clear();
	_implicitReplayTopics.clear();
}
