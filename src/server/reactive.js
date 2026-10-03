// @ts-check
import { now as runtimeNow, wallEpoch, setTimer, clearTimer } from '../shared/runtime.js';
import { _IS_DEV } from './env.js';
import { state, _derivedBySource, _effectBySource, _webhookOutBySource, _aggregateBySource, _watchedTopics, _dynamicDerivedByFn, _silentTopicWatch } from './state.js';
import { _getBus } from './bus.js';
import { _getCtxHelpers, _buildCtx } from './ctx.js';
import { _fireWebhookOut } from './webhook-out.js';
import { _resolveTenant, _tenantTopic, _stripTenantTopic } from './tenant.js';
import { _redactOrDrop, REDACT_DROP, _platformPublish, _noteTopicPublish } from './publish-helpers.js';
import { _gateAggregate, _cohortAdd } from './differential-privacy.js';
import { _enumGates, _enumGateIntercept, _enumGateInterceptBatch } from './rooms-gate.js';
import { diagnosticErrorMessage, emitOperationalEvent } from '../shared/diagnostic.js';

// Seam: the cron leader gate lives in server.js (configureCron). The webhook
// fan-out in fireWatchers consults it through this getter, injected at init.
let _cronLeaderGet = () => null;
// Seam: the tumbling boundary scheduler lives in server.js with the rest of the
// window registration; a window closed outside its timer re-arms through this.
let _scheduleBoundary = (/** @type {any} */ entry, /** @type {any} */ win) => {};
export function installReactive(seams) {
	_cronLeaderGet = seams.cronLeader;
	_scheduleBoundary = seams.scheduleBoundary;
}

/**
 * Compute the public-facing state for one window. For lifetime/tumbling
 * windows this is just `_computeAggregateState(winState.state, reducers)`.
 * For sliding windows the per-bucket state is collapsed via each reducer's
 * `combine` first, then `compute` runs against the combined result.
 *
 * @param {any} winState
 * @param {Record<string, any>} reducers
 * @returns {any}
 */
export function _computeWindowState(winState, reducers) {
	if (winState.type === 'sliding') {
		const merged = {};
		for (const [field, r] of Object.entries(reducers)) {
			if (r.combine) {
				const slices = winState.buckets.map(b => b?.[field]);
				merged[field] = r.combine(...slices);
			} else if (r.init) {
				merged[field] = r.init();
			}
		}
		return _computeAggregateState(merged, reducers);
	}
	return _computeAggregateState(winState.state, reducers);
}

/**
 * Compute aggregate state including computed fields.
 * @param {any} state
 * @param {Record<string, any>} reducers
 * @returns {any}
 */
export function _computeAggregateState(state, reducers) {
	const result = { ...state };
	for (const [field, r] of Object.entries(reducers)) {
		if (r.compute) {
			result[field] = r.compute(result);
		}
	}
	return result;
}

/**
 * How long before a tumbling boundary the event fold starts reading the exact
 * clock. The boundary timer wakes this far ahead and marks the window `near`;
 * from then until the window closes each event checks the exact clock, so an
 * event that arrives after the boundary starts the new window even when the
 * boundary timer runs a little late. The rest of the period an event costs a
 * flag check.
 */
export const _TUMBLE_LEAD_MS = 50;

/** Closing publishes in progress; while one runs, downstream windows do not close. */
let _closingDepth = 0;

/**
 * Report a window publish, or a reducer `init()` starting a new window, that
 * threw. Deliberately loud and repeated (once per window, not deduped): the
 * usual cause of a failed publish is a misconfiguration - a `perturb` /
 * `hybrid` aggregate with no `realtime({ privacySecret })` - and a silenced
 * one-shot warning is how that ships to production unnoticed.
 *
 * @param {any} entry
 * @param {unknown} err
 * @param {'publish' | 'init'} [what]
 */
export function _warnAggregateWindowFailure(entry, err, what = 'publish') {
	console.error(
		"[svelte-realtime] live.aggregate '" + ((entry && (entry.baseTopic || entry.topic)) || 'unknown') + "': " +
		(what === 'init'
			? "a reducer's init() threw as a new window started; the window keeps its previous state until the next boundary.\n  "
			: 'window publish failed; the window keeps tumbling and will retry on the next boundary.\n  ') +
		((err && /** @type {any} */ (err).message) || String(err))
	);
}

/**
 * Compute and publish a window's current state to its output topic. Defaults
 * to `state.cronPlatform` (the captured publish path used by cron and by
 * anything that runs outside an active connection), so boundary and slide
 * timers can publish without an active publish wrapping them. The event fold
 * passes the platform it is publishing through.
 *
 * @param {any} entry
 * @param {any} win
 * @param {any} [platform]
 */
export function _publishWindow(entry, win, platform = state.cronPlatform) {
	if (!platform) return;
	const computed = _computeWindowState(win, entry.reducers);
	// Privacy gate (k-anon suppress / DP noise) then piiRedact, mirroring the
	// event-fold publish in fireWatchers so the timer-driven boundary / slide
	// publishes are gated identically.
	const gated = _gateAggregate(win, computed, win.outputTopic);
	if (!gated.publish) return; // below k: hold the last published value
	const wire = _redactOrDrop(win.outputTopic, gated.value);
	if (wire === REDACT_DROP) return;
	_platformPublish(platform, win.outputTopic, 'set', wire);
}

/**
 * Close a tumbling window once the exact clock `wall` has reached its boundary:
 * publish the closing state, reset to init(), start a fresh k-anonymity cohort
 * and noise seed, and move `nextBoundary` to the first boundary after `wall`.
 * Before the boundary it does nothing, so the boundary timer, the event fold
 * and the window loader can all call it and the window closes once, by
 * whichever runs first.
 *
 * @param {any} entry
 * @param {any} win
 * @param {number} wall - exact wall clock (`wallEpoch()`)
 * @param {any} [platform] - publish path for the closing state
 */
export function _rollTumblingWindow(entry, win, wall, platform) {
	if (wall < win.nextBoundary) return;
	// Advance before any app code runs, so nothing that throws below can leave
	// the window on a boundary that has already passed.
	win.nextBoundary = win.boundaryAfter(wall);
	win.near = win.nextBoundary - wall <= _TUMBLE_LEAD_MS;
	// Closed by an event or a load while the boundary timer still waits for the
	// old boundary, which after a wall clock jump can be further off than the
	// new one: arm it for the new boundary instead.
	if (win.boundaryTimer) {
		clearTimer(win.boundaryTimer);
		win.boundaryTimer = null;
		_scheduleBoundary(entry, win);
	}
	// A pending debounced publish carries the closing window's state; the final
	// publish below supersedes it rather than letting it land in the new window.
	if (win.timer) {
		clearTimer(win.timer);
		win.timer = null;
	}
	// A publish that throws (the privacy gate refusing to emit without an
	// operator secret, a redactor blowing up) must not take the window with it.
	// The closing state belongs to the window that just ended, so an aggregate
	// downstream of this one folds it before closing its own window.
	_closingDepth++;
	try {
		_publishWindow(entry, win, platform);
	} catch (err) {
		_warnAggregateWindowFailure(entry, err);
	} finally {
		_closingDepth--;
	}
	// An init() that throws keeps the window's previous state rather than
	// failing the publish or subscribe that happened to close the window.
	try {
		const fresh = {};
		for (const [field, r] of entry._reducerEntries) {
			if (r.init) fresh[field] = r.init();
		}
		win.state = fresh;
	} catch (err) {
		_warnAggregateWindowFailure(entry, err, 'init');
	}
	// A new window is a new k-anonymity cohort and a fresh noise seed.
	if (win.cohort) win.cohort = new Set();
	if (win.privacy) win._windowStart = win.nextBoundary;
}

/**
 * Tracks platforms whose `publish` has been swapped to `derivedPublish`
 * by `_wrapPlatformPublish`. WeakSet so per-connection platform clones
 * inherit the mutation via prototype chain without forcing the base
 * platform to live longer than the adapter intends - entries clear
 * naturally when the platform itself becomes GC-eligible. The WeakSet
 * is the single source of truth for "is this platform's publish path
 * framework-owned?" - consulted by `_ensureWrap` (the universal idempotent
 * installer), referenced indirectly by every publish surface (RPC, cron,
 * reactive, top-level `publish()`).
 *
 * @type {WeakSet<object>}
 */
const _activatedPlatforms = new WeakSet();

/**
 * Universal install point for the framework's publish wrap. Idempotent
 * against `_activatedPlatforms`, safe under HMR, called from every site
 * that captures or first sees a platform reference:
 * - `setCronPlatform(platform)` - call from `realtime().init` or
 *   directly from `hooks.ws.js`'s `init({ platform })`.
 * - `_activateDerived(platform)` - same call site, alternative entry.
 * - The default `message` hook + `createMessage` returned hook - first
 *   message per platform installs the wrap, so apps that wire only
 *   `setBus(bus)` and re-export `message` (no init hook, no
 *   `_activateDerived` call) still get cluster routing on first RPC.
 *
 * Single install site eliminates the entire class of "outer wrap stacks
 * on inner wrap" bugs: there is only ONE `bus.wrap(...)` call in the
 * whole framework (inside `_wrapPlatformPublish`'s `_refreshBusCache`)
 * and it's composed with everything else (reactive watchers, batched
 * fast path, replay routing) at publish time via the mutated
 * `derivedPublish` / `derivedPublishBatched`.
 *
 * @param {any} platform
 */
export function _ensureWrap(platform) {
	if (!platform) return;
	// svelte-adapter-uws hands hooks a per-connection platform created via
	// Object.create(basePlatform). Wrapping that per-connection object would
	// leave every other connection's inherited publish / publishBatched
	// untouched, because their lookups walk the prototype chain to the
	// original base. Resolve to the base prototype so the wrap is visible
	// to all connections that share it. Test mocks pass plain objects whose
	// proto is Object.prototype - in that case wrap the object itself.
	const target = _resolveWrapTarget(platform);
	if (_activatedPlatforms.has(target)) return;
	_activatedPlatforms.add(target);
	_wrapPlatformPublish(target);
	// Arm wire-subscribe authorization on the adapter (default on): a client's
	// raw subscribe frame is then honored only for a topic the server already
	// authorized for that connection via a stream RPC. Runs once per platform,
	// here at the universal capture point so it covers every wiring path
	// (`realtime().init`, `setCronPlatform`, `_activateDerived`, or first
	// message). The realtime() init hook feature-detects and confirms strict mode
	// before reaching this point; direct primitive wiring remains best-effort.
	// The `platform` reference (possibly a bus-wrapped seam) is used so a
	// clustered deployment reaches the real flag through the forwarded method.
	if (state.authorizeWireSubscribe && typeof (/** @type {any} */ (platform).authorizeWireSubscribe) === 'function') {
		try { /** @type {any} */ (platform).authorizeWireSubscribe('strict'); } catch {}
	}
}

/**
 * Install the publish wrap retroactively if `_activateDerived(platform)`
 * was called against an empty registry and a registration has now landed
 * to populate one. Idempotent: if the wrap is already installed (or no
 * platform was ever activated), this is a no-op. Called from every
 * registration path that populates a `_*BySource` index, including the
 * dynamic-derived bind path.
 *
 * Without this hook, registrations that resolve via the lazy queue
 * (which drains on first cron tick / RPC) - or via direct
 * `__registerXxx(path, fn)` calls in dev-mode SSR fallback - would
 * leave the platform unwrapped, and the very first publish from a
 * cron firehose / startup task / autonomous worker would silently
 * miss every watcher (aggregate / effect / static derived). Manifests
 * as empty leaderboards and `silentTopicWarning` after 30s.
 */
export function _maybeLateActivate() {
	if (!state.derivedPlatform) return;
	_ensureWrap(state.derivedPlatform);
}

/**
 * Walk one prototype hop to find the platform object that OWNS `publish`,
 * so the wrap applies to every per-connection clone created via
 * Object.create(basePlatform). Falls back to the input when there is no
 * useful prototype (test mocks).
 * @param {any} p
 */
function _resolveWrapTarget(p) {
	const proto = Object.getPrototypeOf(p);
	if (proto && proto !== Object.prototype && typeof proto.publish === 'function') {
		return proto;
	}
	return p;
}

function _wrapPlatformPublish(platform) {

	const originalPublish = platform.publish.bind(platform);
	const originalPublishBatched = typeof /** @type {any} */ (platform).publishBatched === 'function'
		? /** @type {any} */ (platform).publishBatched.bind(platform)
		: null;

	// Memoized bus-wrapped surrogate. Recomputed when the process-wide
	// bus changes (detected via `state.busEpoch`). The surrogate's `publish`
	// is `derivedPublishLocal` (local broadcast + watcher fan-out, no
	// re-relay), so inbound bus deliveries fire watchers on the
	// receiving instance without bouncing the message back out onto the
	// bus. The wrapped surrogate's `publish` (set up by the extension's
	// `bus.wrap`) does relay + delegate-to-surrogate; outbound publishes
	// from user code go through `derivedPublish` below, which routes via
	// this cache when a bus is configured.
	let _cachedBusEpoch = -1;
	/** @type {((topic: string, event: string, data: any, opts?: any) => any) | null} */
	let _busPublish = null;
	/** @type {((batch: any) => any) | null} */
	let _busPublishBatched = null;
	function _refreshBusCache() {
		if (_cachedBusEpoch === state.busEpoch) return;
		_cachedBusEpoch = state.busEpoch;
		const bus = _getBus();
		if (!bus) {
			_busPublish = null;
			_busPublishBatched = null;
			return;
		}
		// Surrogate holds derivedPublishLocal as its publish so inbound
		// cluster relays still fire reactive watchers on this instance
		// but do not bounce back out. Spread carries the rest of the
		// platform surface (subscribe, send, redis, replay, ...) so the
		// extensions's bus.wrap sees a complete platform shape.
		/** @type {any} */
		const surrogate = Object.assign(Object.create(Object.getPrototypeOf(platform)), platform);
		surrogate.publish = derivedPublishLocal;
		if (originalPublishBatched) surrogate.publishBatched = derivedPublishBatchedLocal;
		const wrapped = bus.wrap(surrogate);
		_busPublish = typeof wrapped.publish === 'function' ? wrapped.publish.bind(wrapped) : null;
		_busPublishBatched = typeof /** @type {any} */ (wrapped).publishBatched === 'function'
			? /** @type {any} */ (wrapped).publishBatched.bind(wrapped)
			: null;
	}

	let _publishDepth = 0;

	function fireWatchers(topic, event, data) {
		if (!_watchedTopics.has(topic)) return;

		// Guard against infinite recursion (aggregate publishes back through this wrapper)
		if (_publishDepth > 8) return;
		_publishDepth++;
		// try/finally, not a bare decrement at the end: a watcher that THROWS (the
		// aggregate privacy gate refuses to emit without an operator secret, a
		// redactor blows up, a compute() has a bug) would otherwise leak the
		// counter. Nine leaked throws and the guard above is permanently true, so
		// every derived stream, effect, flag cell and aggregate stops firing
		// silently for the rest of the process lifetime.
		try {
			_fireWatchersInner(topic, event, data);
		} finally {
			_publishDepth--;
		}
	}

	function _fireWatchersInner(topic, event, data) {
		// Check if any derived stream watches this topic
		const derivedEntries = _derivedBySource.get(topic);
		if (derivedEntries) {
			for (const entry of derivedEntries) {
				if (entry.debounce > 0) {
					if (entry.timer) clearTimer(entry.timer);
					entry.timer = setTimer(() => {
						entry.timer = null;
						_recomputeDerived(entry, platform);
					}, entry.debounce);
				} else {
					_recomputeDerived(entry, platform);
				}
			}
		}

		// Fire matching effects
		const effectEntries = _effectBySource.get(topic);
		if (effectEntries) {
			for (const entry of effectEntries) {
				if (entry.debounce > 0) {
					if (entry.timer) clearTimer(entry.timer);
					entry.timer = setTimer(() => {
						entry.timer = null;
						_fireEffect(entry, event, data, platform);
					}, entry.debounce);
				} else {
					// Fire-and-forget: don't block the publish path
					Promise.resolve().then(() => _fireEffect(entry, event, data, platform));
				}
			}
		}

		// Fire matching outbound webhooks. Leader-gated SYNCHRONOUSLY here, before
		// scheduling, so non-leader replicas do ~zero work (one cached-boolean
		// read) - the fetch / signing / retries all run off the publish path.
		// Default (no leader) is "every worker fires", same as cron; wire
		// `configureCron({ leader })` for cluster dedup. At-least-once by design
		// (strict exactly-once over HTTP is unachievable); each POST carries an
		// idempotency-key header so receivers can dedup to effectively-once.
		const webhookOutEntries = _webhookOutBySource.get(topic);
		if (webhookOutEntries) {
			let _isLeader = true;
			const _cl = _cronLeaderGet();
			if (_cl !== null) {
				// Fail closed on a throwing leader fn, exactly like the cron tick:
				// better to skip a delivery than double-fire because election broke.
				try { _isLeader = !!_cl(); } catch { _isLeader = false; }
			}
			if (_isLeader) {
				for (const entry of webhookOutEntries) {
					Promise.resolve().then(() => _fireWebhookOut(entry, topic, event, data, platform));
				}
			}
		}

		// Run matching aggregates
		const aggregateEntries = _aggregateBySource.get(topic);
		if (aggregateEntries) {
			for (const entry of aggregateEntries) {
				if (entry.windowed) {
					// Windowed branch: each window holds its own state slice
					// (or hop-bucket array for sliding) and publishes to its
					// own output topic. Per-window debounce overrides the
					// aggregate-level default.
					// A tumbling window whose boundary has passed closes before the
					// event folds in, so the event lands in the window the wall
					// clock puts it in even when the boundary timer has not run yet.
					// Near a boundary the exact clock decides; the cached clock
					// already past it catches a wall clock that jumped forward while
					// the timer waits. Either way the roll itself checks the exact
					// clock. An upstream window's closing state does not close a
					// window: it belongs to the period that is ending.
					const cached = entry._tumbling ? runtimeNow() : 0;
					for (const win of entry.windowStates.values()) {
						if (win.type === 'tumbling' && _closingDepth === 0 && (win.near || cached >= win.nextBoundary)) {
							_rollTumblingWindow(entry, win, wallEpoch(), platform);
						}
						if (win.type === 'sliding') {
							const bucket = win.buckets[win.bucketIndex];
							for (const [field, reducer] of entry._reducerEntries) {
								if (reducer.reduce) {
									bucket[field] = reducer.reduce(bucket[field], event, data);
								}
							}
						} else {
							for (const [field, reducer] of entry._reducerEntries) {
								if (reducer.reduce) {
									win.state[field] = reducer.reduce(win.state[field], event, data);
								}
							}
						}
						const winRef = win;
						// Track the k-anonymity cohort for this window from the event's
						// contributor before gating the publish.
						if (winRef.privacy && winRef.privacy.contributor) {
							try {
								const _c = winRef.privacy.contributor(data);
								const _k = winRef.privacy.k;
								if (winRef.bucketCohorts) _cohortAdd(winRef.bucketCohorts[winRef.bucketIndex], _c, _k);
								else if (winRef.cohort) _cohortAdd(winRef.cohort, _c, _k);
							} catch {}
						}
						// Privacy gate (k-anon suppress / DP noise), then uniform piiRedact
						// (a no-op unless this output topic is also a declared piiRedact stream).
						const _gw = _gateAggregate(winRef, _computeWindowState(win, entry.reducers), winRef.outputTopic);
						if (!_gw.publish) continue; // below k: hold the last published value
						const computed = _redactOrDrop(winRef.outputTopic, _gw.value);
						if (computed === REDACT_DROP) continue;
						if (winRef.debounce > 0) {
							if (winRef.timer) clearTimer(winRef.timer);
							winRef.timer = setTimer(() => {
								winRef.timer = null;
								_platformPublish(platform, winRef.outputTopic, 'set', computed);
							}, winRef.debounce);
						} else {
							_platformPublish(platform, winRef.outputTopic, 'set', computed);
						}
					}
					continue;
				}

				// Apply reducers (single-state)
				for (const [field, reducer] of entry._reducerEntries) {
					if (reducer.reduce) {
						entry.state[field] = reducer.reduce(entry.state[field], event, data);
					}
				}

				// Track the k-anonymity cohort from the event's contributor.
				if (entry.privacy && entry.privacy.contributor) {
					try { _cohortAdd(entry.cohort, entry.privacy.contributor(data), entry.privacy.k); } catch {}
				}
				// Privacy gate (k-anon suppress / DP noise), then uniform piiRedact.
				const _ga = _gateAggregate(entry, _computeAggregateState(entry.state, entry.reducers), entry.topic);
				if (!_ga.publish) continue; // below k: hold the last published value
				const computed = _redactOrDrop(entry.topic, _ga.value);
				if (computed === REDACT_DROP) continue;

				if (entry.debounce > 0) {
					if (entry.timer) clearTimer(entry.timer);
					entry.timer = setTimer(() => {
						entry.timer = null;
						_platformPublish(platform, entry.topic, 'set', computed);
					}, entry.debounce);
				} else {
					_platformPublish(platform, entry.topic, 'set', computed);
				}
			}
		}
	}

	// Inner publish used by the bus-wrap surrogate. Does the local
	// broadcast + watcher fan-out but NEVER relays - relay is the
	// outer `derivedPublish`'s job (via the wrapped surrogate). This
	// is also what runs when an inbound message arrives from another
	// instance, so cluster-relayed events fire derived / effect /
	// aggregate watchers on the receiving instance.
	//
	// It is also the single seam where a per-caller-gated room enumeration
	// channel diverts from the shared broadcast: local-origin AND cluster-
	// inbound deltas both land here immediately before the local fan-out, so
	// the gate's per-subscriber walk always runs on the instance that holds
	// the sockets. Watchers still fire on the raw delta - server-side derived
	// / effect / aggregate code is trusted; only the wire is per-caller.
	function derivedPublishLocal(topic, event, data, opts) {
		// Local delivery is also where a bus relay from another instance lands:
		// an instance holding only subscribers receives every event this way, so
		// the silent-topic watchdog must see it here, not only on the publisher.
		_noteTopicPublish(topic);
		if (_enumGates.size !== 0 && _enumGateIntercept(platform, topic, event, data)) {
			fireWatchers(topic, event, data);
			return true;
		}
		const result = originalPublish(topic, event, data, opts);
		fireWatchers(topic, event, data);
		return result;
	}

	function derivedPublishBatchedLocal(batch) {
		if (_silentTopicWatch.size > 0 && Array.isArray(batch)) {
			for (const item of batch) if (item && typeof item.topic === 'string') _noteTopicPublish(item.topic);
		}
		let rest = batch;
		if (_enumGates.size !== 0 && Array.isArray(batch)) {
			// Divert gated enumeration deltas to the per-subscriber walk; only
			// the remainder broadcasts. Untouched batches come back as the same
			// array, so the common case stays allocation-free.
			rest = _enumGateInterceptBatch(platform, batch);
		}
		const result = (originalPublishBatched && (!Array.isArray(rest) || rest.length > 0)) ? originalPublishBatched(rest) : undefined;
		if (Array.isArray(batch) && _watchedTopics.size > 0) {
			for (const item of batch) {
				if (!item || typeof item.topic !== 'string') continue;
				fireWatchers(item.topic, item.event, item.data);
			}
		}
		return result;
	}

	// Outbound user-facing publish. When a bus is configured, routes
	// through the wrapped surrogate so the publish both broadcasts
	// locally (with watchers) and relays to the cluster in one step.
	// Without a bus, identical to the legacy local-only path.
	platform.publish = function derivedPublish(topic, event, data, opts) {
		_refreshBusCache();
		if (_busPublish) return _busPublish(topic, event, data, opts);
		return derivedPublishLocal(topic, event, data, opts);
	};

	if (originalPublishBatched) {
		// Wrap publishBatched too: ctx.publish takes the batched fast path
		// (queueMicrotask + platform.publishBatched) when no coalesce / transform
		// is registered, which is the default with the uWS adapter. Without
		// this wrap, derived / effect / aggregate watchers never fire on
		// publishes from the batched path - they only fire from the unbatched
		// platform.publish path that some test mocks happen to use.
		/** @type {any} */ (platform).publishBatched = function derivedPublishBatched(batch) {
			_refreshBusCache();
			if (_busPublishBatched) return _busPublishBatched(batch);
			return derivedPublishBatchedLocal(batch);
		};
	}
}

/**
 * Recompute a derived stream and publish the result.
 * For dynamic instances, entry.args holds the runtime args and a ctx is built from the platform.
 * @param {{ fn: Function, topic: string, args?: any[] }} entry
 * @param {import('svelte-adapter-uws').Platform} platform
 */
async function _recomputeDerived(entry, platform) {
	try {
		let result;
		if (entry.args) {
			const _h = _getCtxHelpers(platform);
			const ctx = _buildCtx(entry.user || null, null, platform, _h, null);
			result = await entry.fn(ctx, ...entry.args);
		} else {
			result = await entry.fn();
		}
		// Uniform piiRedact: a derived stream recomputes from sources and may
		// carry PII; redact if its topic declared piiRedact (no-op otherwise).
		const wire = _redactOrDrop(entry.topic, result);
		if (wire !== REDACT_DROP) _platformPublish(platform, entry.topic, 'set', wire);
	} catch (err) {
		if (state.serverErrorHandler) {
			try { state.serverErrorHandler('derived', err); } catch {}
		}
		emitOperationalEvent({
			source: 'svelte-realtime',
			component: 'server.reactive',
			event: 'reactive.derived.failed',
			severity: 'error',
			dataClass: 'application',
			message: 'A derived stream recomputation failed; later source events may retry it.',
			attributes: { topic: entry.topic, error: diagnosticErrorMessage(err), help: 'https://svti.me/derived' }
		});
	}
}

/**
 * Right-to-erasure purge for the k-anonymity cohorts: remove one contributor
 * id from every live aggregate's cohort set (single-state, per-window, and
 * per-hop-bucket alike). The k-gate re-evaluates on the next publish - a
 * cohort shrunk below `k` re-suppresses until enough distinct contributors
 * return, which is the privacy-safe polarity. Reducer STATE is untouched:
 * reducer folds are generally non-invertible, and the aggregate values they
 * hold are exactly the statistical outputs the k-gate governs - removing the
 * user from the cohort is what withdraws the user from the publishing
 * decision. The cohort key is whatever `privacy.contributor(data)` returns;
 * this purge removes the userId-valued key (apps whose contributor keys are
 * not user ids purge through their own key mapping).
 *
 * Returns the number of cohort sets the id was removed from, for the forget
 * cascade's per-surface count.
 * @param {string} contributorId
 * @returns {number}
 */
export function _purgeAggregateCohorts(contributorId) {
	let count = 0;
	/** @type {Set<any>} an aggregate may be registered under several source topics */
	const seen = new Set();
	for (const entries of _aggregateBySource.values()) {
		for (const entry of entries) {
			if (seen.has(entry)) continue;
			seen.add(entry);
			if (entry.cohort && entry.cohort.delete(contributorId)) count++;
			if (entry.windowStates) {
				for (const win of entry.windowStates.values()) {
					if (win.cohort && win.cohort.delete(contributorId)) count++;
					if (win.bucketCohorts) {
						for (const bucket of win.bucketCohorts) {
							if (bucket && bucket.delete(contributorId)) count++;
						}
					}
				}
			}
		}
	}
	return count;
}

/**
 * Activate a dynamic derived instance for a resolved topic.
 * Wires the instance's resolved sources into _derivedBySource so publishes trigger recomputation.
 * @param {Function} fn - The derived compute function
 * @param {string} resolvedTopic - The resolved output topic (e.g. '__derived:5:org_123')
 * @param {any} [user] - The subscribing client's user data, used for ctx during recomputation
 */
export function _activateDynamicDerived(fn, resolvedTopic, user) {
	const entry = _dynamicDerivedByFn.get(fn);
	if (!entry) return;

	// The subscribe hook hands us the WIRE output topic (the dispatch chokepoint
	// prefixed it under a tenant). Instances are keyed by that wire topic, so two
	// tenants subscribing with the same args get independent derived instances and
	// independent outputs. The topicArgs map is keyed by the un-prefixed topic the
	// topicFn produced, so strip the tenant to look the args back up; and the
	// watched sources are prefixed to the subscriber's tenant so the recompute
	// fires on that tenant's writes only (its scoped ctx.publish lands on the same
	// wire source). Null tenant -> all three are no-ops, byte-identical.
	const tenantId = _resolveTenant(user);

	const existing = entry.instances.get(resolvedTopic);
	if (existing) {
		existing.refCount++;
		return;
	}

	// Late activation: if _activateDerived returned early before dynamic
	// entries existed, wrap platform.publish now that we have something
	// to watch. Shared with the static aggregate / effect / derived
	// registration paths via `_maybeLateActivate`.
	_maybeLateActivate();

	const topicArgs = /** @type {any} */ (fn).__derivedTopicArgs;
	const args = topicArgs && topicArgs.get(_stripTenantTopic(tenantId, resolvedTopic));
	if (!args) return;

	const rawSources = entry.sourceFactory(...args);
	if (!Array.isArray(rawSources) || rawSources.length === 0) {
		if (_IS_DEV) {
			console.warn(`[svelte-realtime] Dynamic derived sourceFactory returned empty sources for topic '${resolvedTopic}'\n  See: https://svti.me/derived`);
		}
		return;
	}
	const resolvedSources = tenantId ? rawSources.map((s) => _tenantTopic(tenantId, s)) : rawSources;

	const instance = {
		fn: entry.fn,
		args,
		topic: resolvedTopic,
		resolvedSources,
		debounce: entry.debounce,
		timer: null,
		refCount: 1,
		user: user || null
	};

	entry.instances.set(resolvedTopic, instance);

	for (const src of resolvedSources) {
		let set = _derivedBySource.get(src);
		if (!set) { set = new Set(); _derivedBySource.set(src, set); }
		set.add(instance);
		_watchedTopics.add(src);
	}
}

/**
 * Deactivate a dynamic derived instance when the last subscriber disconnects.
 * Removes the instance from _derivedBySource and cleans up.
 * @param {Function} fn - The derived compute function
 * @param {string} resolvedTopic - The resolved output topic
 */
export function _deactivateDynamicDerived(fn, resolvedTopic, user) {
	const entry = _dynamicDerivedByFn.get(fn);
	if (!entry) return;

	const instance = entry.instances.get(resolvedTopic);
	if (!instance) return;

	instance.refCount--;
	if (instance.refCount > 0) return;

	if (instance.timer) clearTimer(instance.timer);

	for (const src of instance.resolvedSources) {
		const set = _derivedBySource.get(src);
		if (set) {
			set.delete(instance);
			if (set.size === 0) {
				_derivedBySource.delete(src);
				if (!_effectBySource.has(src) && !_aggregateBySource.has(src)) {
					_watchedTopics.delete(src);
				}
			}
		}
	}

	entry.instances.delete(resolvedTopic);
	const topicArgs = /** @type {any} */ (fn).__derivedTopicArgs;
	// topicArgs is keyed by the un-prefixed topic the topicFn produced; strip the
	// tenant from the wire resolvedTopic so the matching entry is removed (parity
	// with the single-tenant cleanup). Null tenant -> no-op strip.
	if (topicArgs) topicArgs.delete(_stripTenantTopic(_resolveTenant(user), resolvedTopic));
}

/**
 * Fire an effect handler. Errors are caught and routed to the error handler.
 * @param {{ fn: Function }} entry
 * @param {string} event
 * @param {any} data
 * @param {import('svelte-adapter-uws').Platform} platform
 */
async function _fireEffect(entry, event, data, platform) {
	try {
		await entry.fn(event, data, platform);
	} catch (err) {
		if (state.serverErrorHandler) {
			try { state.serverErrorHandler('effect', err); } catch {}
		}
		emitOperationalEvent({
			source: 'svelte-realtime',
			component: 'server.reactive',
			event: 'reactive.effect.failed',
			severity: 'error',
			dataClass: 'application',
			message: 'A reactive effect handler failed.',
			attributes: { error: diagnosticErrorMessage(err) }
		});
	}
}
