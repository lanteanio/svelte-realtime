// @ts-check
import { _IS_DEV } from './env.js';
import { _noteTopicPublish } from './publish-helpers.js';
import { _declaredStreamTopic } from './state.js';
import { _stripAnyTenantTopic, _TENANT_TOPIC_NS, _observeTenantWires, _observeTenantTopic, _resetObservedTenantTopicLengths } from './tenant.js';

/**
 * Topics declared with `live.stream(..., { replay: true })`. Populated at
 * declaration time for static topics and at first-subscribe time for
 * dynamic-topic factories (when the topic resolves). When a publish to one
 * of these topics happens (from `ctx.publish`, cron auto-publish, derived /
 * aggregate, anywhere), the framework auto-routes through
 * `platform.replay.publish(...)` so the buffer captures it for gap-fill on
 * resume -- regardless of which seam (RPC / cron / etc.) the publisher
 * sits on. A tenant-scoped wire topic (`@t/<id>/<topic>`) is eligible when
 * its logical topic is.
 *
 * @type {Set<string>}
 */
const _replayEligibleTopics = new Set();

/**
 * Registered untenanted topics by length, so the logical part of a
 * tenant-scoped wire topic is compared against the few topics of its length
 * in place instead of being sliced out and hashed. A length with more than
 * `_BUCKET_MAX` topics maps to `null` and is looked up by slicing.
 *
 * @type {Map<number, string[] | null>}
 */
const _registeredByLength = new Map();
const _BUCKET_MAX = 8;

/** `_topicSignature` of every registered untenanted topic. @type {Set<number>} */
const _registeredSignatures = new Set();

/**
 * Replay streams whose topic is a factory, keyed by the topic pattern derived
 * at declaration. A resolved topic is eligible when it starts with the
 * pattern's literal prefix and the factory reproduces it, so a process that
 * publishes to a topic it has no local subscriber for still writes the buffer.
 * A factory that reads `ctx` or starts with a variable has no pattern; its
 * resolved topics become eligible when a local subscribe resolves them.
 *
 * @type {Map<string, LazyPattern>}
 */
const _replayEligiblePatterns = new Map();

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
		if (!_replayEligibleTopics.has(topic)) {
			_replayEligibleTopics.add(topic);
			if (!topic.startsWith(_TENANT_TOPIC_NS)) {
				_observeTenantTopic(topic);
				_registeredSignatures.add(_topicSignature(topic, topic.length));
				const bucket = _registeredByLength.get(topic.length);
				if (bucket === undefined) _registeredByLength.set(topic.length, [topic]);
				else if (bucket !== null) {
					if (bucket.length < _BUCKET_MAX) bucket.push(topic);
					else _registeredByLength.set(topic.length, null);
				}
			}
		}
		if (implicit) _implicitReplayTopics.add(topic);
	}
}

/**
 * @typedef {{ pattern: string, prefix: string, verify: (topic: string) => boolean }} TopicPattern
 * @typedef {{ resolve: () => TopicPattern | null, value: TopicPattern | null | undefined }} LazyPattern
 */

/**
 * Register the topic pattern of a replay stream whose topic is a factory.
 * Called from `live.stream` declaration with the factory's source as `key`, so
 * an HMR reload replaces its entry. The pattern is resolved on first use,
 * which only a platform with `platform.replay` reaches, so a factory is never
 * probed in an app without a buffer.
 *
 * @param {string} key
 * @param {() => TopicPattern | null} resolve
 */
export function _registerReplayPattern(key, resolve) {
	_replayEligiblePatterns.set(key, { resolve, value: undefined });
}

/**
 * Factory streams and channels without replay. A replay pattern does not
 * claim a topic one of them also produces under a different pattern:
 * `'room-' + id` would otherwise take `'room-' + id + '-typing'`.
 * @type {Map<string, LazyPattern>}
 */
const _otherFactoryPatterns = new Map();

/**
 * Register a factory stream or channel without replay; resolved like
 * `_registerReplayPattern`.
 * @param {string} key
 * @param {() => TopicPattern | null} resolve
 */
export function _registerFactoryOwner(key, resolve) {
	_otherFactoryPatterns.set(key, { resolve, value: undefined });
}

/** @param {LazyPattern} entry @returns {TopicPattern | null} */
function _patternOf(entry) {
	if (entry.value === undefined) {
		try { entry.value = entry.resolve(); } catch { entry.value = null; }
	}
	return /** @type {TopicPattern | null} */ (entry.value);
}

/**
 * Whether a factory without replay, of another pattern, also produces `logical`.
 * @param {string} logical
 * @param {string} replayPattern
 */
function _producedByOtherFactory(logical, replayPattern) {
	for (const entry of _otherFactoryPatterns.values()) {
		const other = _patternOf(entry);
		if (other !== null && other.pattern !== replayPattern && logical.startsWith(other.prefix) && other.verify(logical)) return true;
	}
	return false;
}

const NOT_ELIGIBLE = 0;
const ELIGIBLE_TOPIC = 1;
const ELIGIBLE_PATTERN = 2;

/**
 * Register the wire topic `_tenantTopic` built for a registered logical topic.
 * The logical topic is in hand there, so a tenant-scoped publish to it hits
 * the exact registry and a publish to any other topic pays nothing on the
 * publish path. Only a logical topic whose length a registered topic has is
 * looked up. Growth is bounded by tenants times registered topics.
 *
 * @param {string} wire
 * @param {string} logical
 */
function _noteTenantWire(wire, logical) {
	const n = logical.length;
	if (!_registeredByLength.has(n)) return;
	if (!_registeredSignatures.has(_topicSignature(logical, n))) return;
	if (_replayEligibleTopics.has(logical)) _replayEligibleTopics.add(wire);
}

/**
 * Length, first and last character of a topic in one number: a cheap filter
 * that settles most topics of a registered length without hashing them.
 * @param {string} topic
 * @param {number} n - `topic.length`, at least 1
 */
function _topicSignature(topic, n) {
	return n * 65536 + topic.charCodeAt(0) * 256 + (topic.charCodeAt(n - 1) & 255);
}
_observeTenantWires(_noteTenantWire);

/**
 * Whether a wire topic belongs to a replay stream: by its own registration
 * (a tenant-scoped wire topic of a registered topic is registered when it is
 * built), by the logical topic of a tenant-scoped topic built some other way,
 * or by a factory pattern. A topic another stream declared explicitly is
 * never claimed by a pattern. Without factory patterns a publish pays one set
 * lookup, as before.
 *
 * @param {string} topic
 * @returns {number}
 */
function _replayEligibility(topic) {
	if (_replayEligibleTopics.has(topic)) return ELIGIBLE_TOPIC;
	if (_replayEligiblePatterns.size === 0 || typeof topic !== 'string') return NOT_ELIGIBLE;
	// The logical topic of `@t/<id>/<topic>` starts at `start`; it is sliced
	// out only for a registered length or a matching pattern prefix.
	let start = 0;
	// '@', 't', '/': the tenant namespace `_TENANT_TOPIC_NS`, compared by code.
	if (topic.charCodeAt(0) === 64 && topic.charCodeAt(1) === 116 && topic.charCodeAt(2) === 47) {
		const slash = topic.indexOf('/', 3);
		if (slash !== -1) {
			start = slash + 1;
			const bucket = _registeredByLength.get(topic.length - start);
			if (bucket === null) {
				if (_replayEligibleTopics.has(topic.slice(start))) return ELIGIBLE_TOPIC;
			} else if (bucket !== undefined) {
				for (let i = 0; i < bucket.length; i++) if (topic.endsWith(bucket[i])) return ELIGIBLE_TOPIC;
			}
		}
	}
	for (const entry of _replayEligiblePatterns.values()) {
		const own = _patternOf(entry);
		if (own === null || !topic.startsWith(own.prefix, start)) continue;
		const logical = start === 0 ? topic : topic.slice(start);
		if (_declaredStreamTopic.has(logical)) return NOT_ELIGIBLE;
		if (own.verify(logical)) return _producedByOtherFactory(logical, own.pattern) ? NOT_ELIGIBLE : ELIGIBLE_PATTERN;
	}
	return NOT_ELIGIBLE;
}

/** @param {string} topic */
function _isImplicitReplayTopic(topic) {
	return _implicitReplayTopics.has(topic) || (topic.charCodeAt(0) === 64 && _implicitReplayTopics.has(_stripAnyTenantTopic(topic)));
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
	// The common case first, at the cost it always had: no factory pattern
	// could match and the topic is not registered.
	if (_replayEligiblePatterns.size === 0 && !_replayEligibleTopics.has(topic)) return false;
	const replay = platform && /** @type {any} */ (platform).replay;
	if (!replay || typeof replay.publish !== 'function') {
		// Without a buffer only the missing-extension warning needs an answer,
		// and a pattern match never warns: internal streams declare factory
		// topics with an implicit buffer, and a user's factory stream warns once
		// a subscribe resolves its topic. So no pattern is evaluated here.
		if (!_IS_DEV || !_replayEligibleTopics.has(topic) || _isImplicitReplayTopic(topic)) return false;
		const warnKey = typeof topic === 'string' && topic.charCodeAt(0) === 64 ? _stripAnyTenantTopic(topic) : topic;
		if (!_replayMissingWarned.has(warnKey)) {
			_replayMissingWarned.add(warnKey);
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
	if (_replayEligibility(topic) === NOT_ELIGIBLE) return false;
	if (/** @type {any} */ (platform)[WRAPPED_FOR_REPLAY]) return false;
	// The extension broadcasts through platform.publish internally, so this
	// is the only place the framework can observe the event for the dev watchdog.
	_noteTopicPublish(topic);
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
 * Erasure must observe replay acknowledgement instead of the normal best-effort
 * publication path. Keep confirmation work off ordinary publication calls.
 * @internal
 */
export function _confirmedReplayPublish(platform, topic, event, data) {
	const replay = platform && platform.replay;
	if (_replayEligibility(topic) === NOT_ELIGIBLE || !replay || typeof replay.publish !== 'function'
		|| platform[WRAPPED_FOR_REPLAY]) return false;
	_noteTopicPublish(topic);
	return Promise.resolve(replay.publish(platform, topic, event, data)).then(() => true);
}

/**
 * Reset replay-routing state. Tests only.
 * @internal
 */
export function _resetReplayRouting() {
	_replayEligibleTopics.clear();
	_registeredByLength.clear();
	_registeredSignatures.clear();
	_resetObservedTenantTopicLengths();
	_replayEligiblePatterns.clear();
	_otherFactoryPatterns.clear();
	_replayMissingWarned.clear();
	_implicitReplayTopics.clear();
}
