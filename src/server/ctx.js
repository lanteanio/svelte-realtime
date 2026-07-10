// @ts-check
import { now as runtimeNow, microtask } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _IS_DEV } from './env.js';
import { _ctxHelpersCache, _topicVolatile, _topicStaleWatch, _silentTopicWatch, _topicInvalidationWatch, _topicCoalesce, _topicTransform, _topicRedact, _declaredRedact } from './state.js';
import { _maybeReplayPublish } from './replay-routing.js';
import { _checkPublishHelperArgs, _throttlePublish, _debouncePublish, _skipGate, _redactOrDrop, REDACT_DROP, _resolveRedactor } from './publish-helpers.js';
import { _validUserIdReason } from './validate.js';
import { _shouldShed } from './admission.js';
import { _runtimeRandom, _localHlc } from './runtime-fallbacks.js';
import { _compensateUnavailable } from './history-compensation.js';
import { _observeSilentTopicPublish, _activatePublishRateWarning } from './dev-warnings.js';
import { _resolveTenant, _tenantTopic, _makeTenantScope } from './tenant.js';

/**
 * Reject a publish to a `__`-prefixed (framework-internal) topic. Shared by the
 * raw publish helper and the tenant-scoped wrapper so the reserved-channel guard
 * holds on the LOGICAL topic on both paths (the wrapper checks before prefixing,
 * so a tenant cannot reach a `__signal:*` / `__replay:*` channel either).
 * @param {any} topic
 */
function _assertNotReservedTopic(topic) {
	if (typeof topic === 'string' && topic.length >= 2 && topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) {
		throw new LiveError(
			'INVALID_TOPIC',
			"ctx.publish() refuses '__'-prefixed topics; those are reserved for " +
			'framework-internal channels. Use platform.publish(...) directly if ' +
			'you genuinely need to broadcast on a system channel.'
		);
	}
}

/**
 * Tenant-scoped publish wrappers, memoized per (raw-publish, tenantId) so a
 * multi-tenant deploy allocates one wrapper per tenant, not one per RPC. The
 * wrapper guards the LOGICAL topic then prefixes once to the tenant's wire
 * namespace before delegating to the raw `helpers.publish` (which keys every
 * topic-registry by the wire topic - matching the wire topic registered at
 * subscribe). Single-tenant ctx never touches this (ctx.publish stays the raw helper).
 * @type {WeakMap<Function, Map<string, Function>>}
 */
const _scopedPublishCache = new WeakMap();
function _getScopedPublish(rawPublish, tenantId) {
	let byTenant = _scopedPublishCache.get(rawPublish);
	if (!byTenant) { byTenant = new Map(); _scopedPublishCache.set(rawPublish, byTenant); }
	let scoped = byTenant.get(tenantId);
	if (!scoped) {
		scoped = function publish(topic, event, data, options) {
			_assertNotReservedTopic(topic);
			return rawPublish(_tenantTopic(tenantId, topic), event, data, options);
		};
		byTenant.set(tenantId, scoped);
	}
	return scoped;
}

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
			_assertNotReservedTopic(topic);
			// De-herd window validation: clamp the `{ jitterMs }` contract at the call
			// site so a bad value is a clear error, not a silently-huge client defer.
			// 0 / absent = immediate (today's behavior); 60s ceiling matches the wire.
			if (options && options.jitterMs !== undefined) {
				const _j = options.jitterMs;
				if (typeof _j !== 'number' || !Number.isFinite(_j) || _j < 0 || _j > 60000) {
					throw new LiveError('VALIDATION', '[svelte-realtime] ctx.publish jitterMs must be a finite number of milliseconds in [0, 60000]');
				}
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
			if (_topicCoalesce.size === 0 && _topicTransform.size === 0 && _topicRedact.size === 0 && _declaredRedact.size === 0) {
				// A jittered publish carries a de-herd window `j` only on the single
				// `platform.publish` envelope - not the replay buffer or the batch
				// frame - so it takes the direct path. That is the right shape: jitter
				// is a rare control event (degraded notice, flag flip, reroute), never
				// a hot, replayed, or coalesced stream.
				const _jittered = !!(finalOptions && finalOptions.jitterMs > 0);
				// Replay-eligible topics route through `platform.replay.publish`
				// so the bounded buffer captures the event for gap-fill on
				// resume. The replay extension calls `platform.publish`
				// internally, so the local broadcast still happens. Cannot
				// batch through publishBatched in this case -- the extension's
				// per-call write is what stamps the seq envelope.
				if (!_jittered && _maybeReplayPublish(platform, topic, event, data)) return true;
				if (_jittered || !_hasBatched) return platform.publish(topic, event, data, finalOptions);
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
			// PII redaction runs immediately after transform and before BOTH
			// the replay buffer (_maybeReplayPublish below) and the fan-out, so
			// it is uniform across every subscriber and raw PII never rests in
			// the replay store. Fail-closed: a throwing redactor drops the
			// publish (routed to the stream's onError if set) rather than
			// broadcasting un-redacted data. The redactor is non-mutating, so a
			// transform-less topic (wireData === data) is not corrupted in place.
			const r = _resolveRedactor(topic);
			if (r) {
				try {
					wireData = r.redact(wireData);
				} catch (err) {
					if (r.onError) {
						try { r.onError(err, null, topic); } catch {}
						return false;
					}
					throw err;
				}
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
			// Cross-instance: the loop above only reaches THIS instance's sockets.
			// When the pubsub extension is wrapped in, relay a coalesced envelope so
			// every other instance re-coalesces this latest value onto its own
			// subscribers; without it a clustered coalesceBy topic silently delivers
			// to the publishing instance only. In-memory / single-instance has no
			// relayCoalesced, so it stays byte-identical.
			if (platform.relayCoalesced) platform.relayCoalesced(topic, event, wireData, coalesceKey);
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
			batch: (messages) => {
					// No native batch: fall back to the redacting `publish` closure
					// per message (it applies piiRedact + replay routing itself).
					if (!platform.batch) { for (const m of messages) publish(m.topic, m.event, m.data, m.options); return; }
					// Native batch bypasses the `publish` closure, so apply uniform
					// piiRedact here. Fail-closed: a message whose redactor throws is
					// dropped from the batch rather than broadcast raw.
					if (_topicRedact.size > 0 || _declaredRedact.size > 0) {
						const out = [];
						for (const m of messages) {
							const d = _redactOrDrop(m.topic, m.data);
							if (d === REDACT_DROP) continue;
							out.push(d === m.data ? m : { ...m, data: d });
						}
						messages = out;
					}
					return platform.batch(messages);
				},
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
/**
 * Default `ctx.setAlarm` / `ctx.deleteAlarm` outside an alarm-enabled stream: a
 * clear error. A stream/room declared with `{ alarm: { onAlarm } }` shadows these
 * with live closures (via `alarm.js#_bindAlarmCtx`) the same way a `history` room
 * shadows `ctx.compensate`. Declared here (not imported from alarm.js) so the ctx
 * module has no dependency on the alarm module - alarm.js depends on ctx, not the
 * reverse.
 */
function _alarmUnavailable() {
	throw new LiveError('VALIDATION', '[svelte-realtime] ctx.setAlarm / ctx.getAlarm / ctx.deleteAlarm require a live.stream (or live.room) declared with an { alarm: { onAlarm } } config.');
}

/** Default `ctx.getAlarm` outside an alarm-enabled stream: null (no alarm to read), not a throw. */
function _alarmGetUnavailable() {
	return null;
}

/**
 * The `ctx.batch(fn)` atomic collector: run `fn`, buffer every `ctx.publish`
 * it makes - across awaits - then publish them all when `fn` returns (or its
 * promise resolves), and drop them ALL when it throws (or rejects). A rejected
 * handler never leaves a partial publish trail.
 *
 * Two deliberate contrasts to document at the call site:
 * - Bare `ctx.publish` outside a collector flushes at each microtask boundary,
 *   so an `await` splits publishes into separate wire batches and a pre-await
 *   publish is already gone when a later throw happens. Inside `ctx.batch(fn)`
 *   the publishes are HELD across awaits precisely so a post-await throw can
 *   retract them - atomicity is the entire point of the collector form.
 * - The client-side `batch(fn)` shares the name and callback shape but has the
 *   opposite failure contract (each collected RPC settles independently).
 *
 * Only `ctx.publish` is collected. `publishThrottled` / `publishDebounced`
 * (timer-deferred), `signal` (point-to-point), `ctx.tenant(id).publish` (an
 * explicit cross-tenant escape), and the framework-internal `_publishWire`
 * all pass through immediately - they are not broadcast side-effects of the
 * handler's own resolution.
 *
 * Buffered messages flush through the REAL publish closure, so tenant
 * scoping, redaction, replay routing, invalidation, and the microtask
 * auto-batch all still apply - the collector only defers, it never bypasses.
 * Nesting composes: the inner collector's flush routes into the outer
 * collector's shadow. The shadow lives on the per-invocation ctx object, so
 * concurrent handlers can never observe each other's collector.
 *
 * Residual edge (accepted): a throw DURING flush (e.g. a redactor throwing at
 * commit time) can leave earlier buffered messages already published - the
 * drop-before-flush guarantee covers `fn`'s own failure, which is the
 * atomicity the feature promises.
 *
 * @param {any} ctx
 * @param {(ctx: any) => any} fn
 */
function _collectBatch(ctx, fn) {
	// Capture the EXACT current publish reference: the tenant-scoped wrapper
	// when the connection is tenant-resolved, or an outer collector's shadow
	// when nested.
	const realPublish = ctx.publish;
	/** @type {Array<[string, string, any, any]>} */
	const buffer = [];
	ctx.publish = (topic, event, data, options) => {
		buffer.push([topic, event, data, options]);
		return true;
	};
	const flush = () => {
		ctx.publish = realPublish;
		for (const [topic, event, data, options] of buffer) realPublish(topic, event, data, options);
	};
	const drop = () => {
		ctx.publish = realPublish;
		buffer.length = 0;
	};
	let result;
	try {
		result = fn(ctx);
	} catch (err) {
		drop();
		throw err;
	}
	if (result && typeof result.then === 'function') {
		return result.then(
			(value) => { flush(); return value; },
			(err) => { drop(); throw err; }
		);
	}
	flush();
	return result;
}

export function _buildCtx(user, ws, platform, helpers, cursor, idempotencyKey) {
	// Server-trusted tenant id for this connection (null when no resolver is
	// configured -> single-tenant, zero-cost path). When set, ctx.publish prefixes
	// every topic to the tenant's wire namespace; ctx._publishWire stays the raw
	// helper for framework code that already holds a wire topic (no double-prefix).
	const tenantId = _resolveTenant(user);
	const ctx = {
		user,
		ws,
		platform,
		publish: tenantId ? _getScopedPublish(helpers.publish, tenantId) : helpers.publish,
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
		// Per-room alarm (live.alarm). Defaults throw / return-null outside an
		// alarm-enabled stream; an alarm-enabled stream/room shadows them with live
		// closures bound to the room topic (same value-swap-not-shape-change rule as
		// compensate, to keep one hidden class).
		setAlarm: _alarmUnavailable,
		getAlarm: _alarmGetUnavailable,
		deleteAlarm: _alarmUnavailable,
		_idempotencyKey: idempotencyKey || null,
		// Multi-tenancy. `tenantId` is the connection's server-trusted tenant (or
		// null). `_publishWire` is the raw, non-prefixing publish for framework
		// code that already holds a wire topic (presence/cursor/room-action), so it
		// never double-prefixes. `tenant(id)` returns a publisher scoped to ANOTHER
		// tenant - the explicit cross-tenant escape hatch. All three are present on
		// every ctx (value swap, not shape change) to keep one hidden class.
		tenantId,
		_publishWire: helpers.publish,
		tenant: (id) => _makeTenantScope(helpers.publish, id)
	};
	// `ctx.batch(fn)` atomic-collector overload beside the list form. Assigned
	// after the literal so the closure can capture the ctx instance (the
	// collector shadows THIS invocation's ctx.publish - per-call by
	// construction, so concurrent handlers never interfere); a value swap on
	// an existing slot, so the hidden class is unchanged.
	ctx.batch = (arg) => (typeof arg === 'function' ? _collectBatch(ctx, arg) : helpers.batch(arg));
	return ctx;
}
