// @ts-check
import { now as runtimeNow, microtask } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _IS_DEV } from './env.js';
import { _ctxHelpersCache, _topicVolatile, _topicStaleWatch, _silentTopicWatch, _topicInvalidationWatch, _topicCoalesce, _topicTransform } from './state.js';
import { _maybeReplayPublish } from './replay-routing.js';
import { _checkPublishHelperArgs, _throttlePublish, _debouncePublish, _skipGate } from './publish-helpers.js';
import { _validUserIdReason } from './validate.js';
import { _shouldShed } from './admission.js';
import { _runtimeRandom, _localHlc } from './runtime-fallbacks.js';
import { _compensateUnavailable } from './history-compensation.js';
import { _observeSilentTopicPublish, _activatePublishRateWarning } from './dev-warnings.js';

// Seam callbacks injected by server.js at init. The stale-watch + invalidation
// subsystems live in server.js (wired to the subscribe / unsubscribe / close
// paths), so the ctx publish helper reaches them through this seam. The
// silent-topic + publish-rate-warning helpers come directly from dev-warnings.js.
let _resetStaleTimer;
let _invalidationReload;
export function installCtx(seams) {
	_resetStaleTimer = seams.resetStaleTimer;
	_invalidationReload = seams.invalidationReload;
}

/** Dev-warn dedup: one-time "ctx.throttle is deprecated" warning. */
let _throttleDeprecatedWarned = false;
/** Dev-warn dedup: one-time "ctx.debounce is deprecated" warning. */
let _debounceDeprecatedWarned = false;

/**
 * Get cached ctx helper methods for a platform.
 * Avoids creating new closures on every RPC call.
 * @param {import('svelte-adapter-uws').Platform} platform
 * @returns {{ publish: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function }}
 */
export function _getCtxHelpers(platform) {
	let helpers = _ctxHelpersCache.get(platform);
	if (!helpers) {
		if (_IS_DEV) _activatePublishRateWarning(platform);
		// Per-platform microtask-scoped batch buffer. Every ctx.publish() that
		// can route through platform.publishBatched (no per-topic coalesce or
		// sendCoalesced fanout) is queued here; the buffer drains in one
		// queueMicrotask and is handed to the adapter as a single batched
		// frame, fanning out as one WebSocket frame per subscriber. The
		// adapter handles capability negotiation and per-event fallback for
		// non-batch-capable subscribers, so the call is always safe.
		/** @type {Array<{ topic: string, event: string, data: any, options: any }> | null} */
		let pendingBatch = null;
		const _hasBatched = typeof /** @type {any} */ (platform).publishBatched === 'function';
		const _flushBatch = () => {
			const batch = pendingBatch;
			pendingBatch = null;
			if (batch && batch.length > 0) /** @type {any} */ (platform).publishBatched(batch);
		};
		const publish = function publish(topic, event, data, options) {
			// Reserve the `__` prefix for framework-internal channels
			// (`__signal:userId`, `__rpc`, `__upload`, plugin `__presence:*` /
			// `__group:*` / `__replay:*`). User code that publishes to those
			// channels can spoof framework-internal frames; combined with the
			// wire-side block on subscribing to system topics, the only
			// legitimate publisher of internal channels is the framework
			// itself via the lower-level `platform.publish(...)`. Apps that
			// genuinely need to broadcast on a `__`-prefixed topic should
			// reach for the unwrapped `platform.publish` directly so the
			// intent is explicit at the call site.
			if (typeof topic === 'string' && topic.length >= 2 && topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) {
				throw new LiveError(
					'INVALID_TOPIC',
					"ctx.publish() refuses '__'-prefixed topics; those are reserved for " +
					'framework-internal channels. Use platform.publish(...) directly if ' +
					'you genuinely need to broadcast on a system channel.'
				);
			}
			// Volatile option translation. Per-call `options.volatile` or a
			// topic registered as volatile turns into `seq: false` on the wire
			// so reconnect with `lastSeenSeq` won't try to backfill the gap.
			// Wire-level drop-on-backpressure is the adapter's job
			// (uWS maxBackpressure auto-skips backpressured subscribers); this
			// only governs seq stamping and intent declaration. The check
			// short-circuits when no caller passes volatile and no stream
			// registered it - no alloc on the common case.
			let finalOptions = options;
			if ((options && options.volatile) || (_topicVolatile.size > 0 && _topicVolatile.has(topic))) {
				finalOptions = { ...(options || {}), seq: false };
			}
			// Reset the staleness watchdog: a publish proves the topic is
			// live, so the silence clock restarts. The size check makes
			// this free for apps that don't use staleAfterMs.
			if (_topicStaleWatch.size > 0) _resetStaleTimer(topic);
			// Mark the topic as live for the silent-topic dev warning.
			// One Map.size check on the publish hot path; constant-folded
			// in production builds via the _IS_DEV gate when the registry
			// is never armed.
			if (_silentTopicWatch.size > 0) _observeSilentTopicPublish(topic);
			// Topic-driven invalidation: every publish whose topic matches
			// a registered `invalidateOn` pattern triggers a loader re-run
			// for the watching stream. Skipped for `refreshed` events --
			// those are emitted BY the reload itself, so honoring them
			// would loop. Size-zero short-circuit keeps this free for apps
			// that don't use the feature.
			if (_topicInvalidationWatch.size > 0 && event !== 'refreshed') {
				for (const entry of _topicInvalidationWatch.values()) {
					// Literal-prefix fast-fail: cheap startsWith filters the
					// majority of unrelated patterns before we touch the
					// regex engine. For `prefix*` patterns the regex is
					// equivalent to startsWith + at-least-one-more-char, so
					// we skip it entirely on the common case.
					if (entry.prefix && !topic.startsWith(entry.prefix)) continue;
					if (entry.prefixOnly) {
						if (topic.length <= entry.prefix.length) continue;
					} else if (!entry.regex.test(topic)) continue;
					for (const watcher of entry.watchers) _invalidationReload(watcher);
				}
			}
			// Fast path: no per-topic feature registry hits and adapter exposes
			// publishBatched -> queue for microtask flush. The cross-worker
			// relay already coalesces per-microtask postMessages; this lifts
			// the same idea to the wire level so subscribers receive ONE frame
			// per microtask containing every event they're entitled to.
			if (_topicCoalesce.size === 0 && _topicTransform.size === 0) {
				// Replay-eligible topics route through `platform.replay.publish`
				// so the bounded buffer captures the event for gap-fill on
				// resume. The replay extension calls `platform.publish`
				// internally, so the local broadcast still happens. Cannot
				// batch through publishBatched in this case -- the extension's
				// per-call write is what stamps the seq envelope.
				if (_maybeReplayPublish(platform, topic, event, data)) return true;
				if (!_hasBatched) return platform.publish(topic, event, data, finalOptions);
				if (!pendingBatch) {
					pendingBatch = [];
					microtask(_flushBatch);
				}
				pendingBatch.push({ topic, event, data, options: finalOptions });
				return true;
			}
			const c = _topicCoalesce.get(topic);
			const t = _topicTransform.get(topic);
			// coalesceBy reads the ORIGINAL data (before transform) so the key
			// extractor sees the un-projected fields it was written against.
			// Throws are routed to the registered stream's onError (if any),
			// dropping the publish silently. Without an observer, the throw
			// propagates so apps that haven't opted into the observer pattern
			// still see failures.
			let coalesceKey;
			if (c) {
				try {
					coalesceKey = c.coalesceBy(data);
				} catch (err) {
					if (c.onError) {
						try { c.onError(err, null, topic); } catch {}
						return false;
					}
					throw err;
				}
			}
			// Transform produces the wire data once - applied here, before
			// fan-out, so every subscriber sees the same projected shape.
			// Throws are routed to the registered stream's onError (if any).
			// With an observer set, the publish is dropped silently (return
			// false) - transform failure means the wire data is invalid, so
			// fanning out wouldn't help. Without an observer, the throw
			// propagates so apps that haven't opted into the observer pattern
			// still see failures.
			let wireData;
			if (t) {
				try {
					wireData = t.transform(data);
				} catch (err) {
					if (t.onError) {
						try { t.onError(err, null, topic); } catch {}
						return false;
					}
					throw err;
				}
			} else {
				wireData = data;
			}
			if (!c) {
				// Transform-only topic: stays on the queued batched path,
				// unless replay-eligible -- then route per-call so the
				// extension can stamp the seq envelope before broadcast.
				if (_maybeReplayPublish(platform, topic, event, wireData)) return true;
				if (!_hasBatched) return platform.publish(topic, event, wireData, finalOptions);
				if (!pendingBatch) {
					pendingBatch = [];
					microtask(_flushBatch);
				}
				pendingBatch.push({ topic, event, data: wireData, options: finalOptions });
				return true;
			}
			// coalesceBy topic: per-ws sendCoalesced replacement. Distinct
			// adapter primitive (latest-value-wins per-ws-per-key); not folded
			// into publishBatched because the two have incompatible wire
			// shapes (separate per-subscriber Map vs shared batched frame).
			const fullKey = topic + '\0' + (coalesceKey == null ? '' : coalesceKey);
			let last = true;
			for (const ws of c.ws) {
				last = platform.sendCoalesced(ws, { key: fullKey, topic, event, data: wireData });
			}
			return last;
		};
		helpers = {
			publish,
			publishThrottled: (...args) => {
				_checkPublishHelperArgs('publishThrottled', args);
				return _throttlePublish(platform, /** @type {string} */ (args[0]), /** @type {string} */ (args[1]), args[2], /** @type {number} */ (args[3]));
			},
			publishDebounced: (...args) => {
				_checkPublishHelperArgs('publishDebounced', args);
				return _debouncePublish(platform, /** @type {string} */ (args[0]), /** @type {string} */ (args[1]), args[2], /** @type {number} */ (args[3]));
			},
			throttle: (...args) => {
				if (_IS_DEV && !_throttleDeprecatedWarned) {
					_throttleDeprecatedWarned = true;
					console.warn(
						'[svelte-realtime] ctx.throttle is deprecated -- rename to ctx.publishThrottled. ' +
						'The old name reads like a handler gate, but it is a 4-arg publish helper. ' +
						'For per-key handler gating use ctx.skip(key, ms); the publish-helper behaviour ' +
						'is unchanged. This warning fires once per process.\n' +
						'  See: https://svti.me/publish-throttled'
					);
				}
				_checkPublishHelperArgs('throttle', args);
				return _throttlePublish(platform, /** @type {string} */ (args[0]), /** @type {string} */ (args[1]), args[2], /** @type {number} */ (args[3]));
			},
			debounce: (...args) => {
				if (_IS_DEV && !_debounceDeprecatedWarned) {
					_debounceDeprecatedWarned = true;
					console.warn(
						'[svelte-realtime] ctx.debounce is deprecated -- rename to ctx.publishDebounced. ' +
						'The old name reads like a handler gate, but it is a 4-arg publish helper. ' +
						'For per-key handler gating use ctx.skip(key, ms); the publish-helper behaviour ' +
						'is unchanged. This warning fires once per process.\n' +
						'  See: https://svti.me/publish-debounced'
					);
				}
				_checkPublishHelperArgs('debounce', args);
				return _debouncePublish(platform, /** @type {string} */ (args[0]), /** @type {string} */ (args[1]), args[2], /** @type {number} */ (args[3]));
			},
			signal: (userId, event, data) => {
				const reason = _validUserIdReason(userId);
				if (reason !== null) throw new LiveError('INVALID_USER_ID', 'ctx.signal: ' + reason);
				return platform.publish('__signal:' + userId, event, data);
			},
			batch: (messages) => platform.batch ? platform.batch(messages) : messages.forEach((m) => publish(m.topic, m.event, m.data, m.options)),
			shed: (className) => _shouldShed(platform, className),
			skip: (key, ms) => _skipGate(key, ms)
		};
		_ctxHelpersCache.set(platform, helpers);
	}
	return helpers;
}

/**
 * Build a ctx object with a stable V8 hidden class.
 * All call sites must use this factory to ensure monomorphic property access.
 * Same property count, same order, same types at each slot -> single hidden class.
 * @param {any} user
 * @param {any} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ publish: Function, publishThrottled: Function, publishDebounced: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function, skip: Function }} helpers
 * @param {any} cursor
 * @param {string | null} [idempotencyKey] Envelope-supplied idempotency key, or null. Internal use only.
 * @returns {any}
 */
export function _buildCtx(user, ws, platform, helpers, cursor, idempotencyKey) {
	return {
		user,
		ws,
		platform,
		publish: helpers.publish,
		cursor,
		publishThrottled: helpers.publishThrottled,
		publishDebounced: helpers.publishDebounced,
		throttle: helpers.throttle,
		debounce: helpers.debounce,
		signal: helpers.signal,
		batch: helpers.batch,
		shed: helpers.shed,
		skip: helpers.skip,
		requestId: platform.requestId,
		// Clock and RNG come from the adapter platform's injectable runtime when
		// present, so a loader/handler reads the same swappable source a seeded
		// harness controls (ctx.now(), ctx.random.uuid(), etc.). Older adapters
		// and mock platforms without them fall back to the framework's own
		// runtime helpers, so the surface is always populated.
		now: (platform && platform.now) || runtimeNow,
		random: (platform && platform.random) || _runtimeRandom,
		// Hybrid logical clock for events that must order consistently across
		// workers (or across a coarse / briefly-backward wall clock). Comes
		// from the adapter platform when it projects one, so a loader/handler
		// reads the same swappable source a seeded harness controls; older
		// adapters and mock platforms fall back to the framework's own
		// runtime-backed stamp of the same {wall, logical, nodeId} shape.
		hlc: (platform && platform.hlc) || _localHlc,
		// Lag-compensated evaluation. The default throws with guidance; room
		// actions on a room with a `history` config shadow it with the live
		// implementation (the same shadow-and-restore pattern as ctx.publish).
		// Declared here so every ctx shares one hidden class - the shadow
		// swaps the value, never the shape.
		compensate: _compensateUnavailable,
		_compensateDepth: 0,
		_idempotencyKey: idempotencyKey || null
	};
}
