// @ts-check
import { writable } from 'svelte/store';
import { connect as _connect, on } from 'svelte-adapter-uws/client';
import { createJitterDispatch } from './jitter-dispatch.js';
import { _IS_DEV } from './internal-state.js';

/**
 * Quiescence tracking: count of streams currently in `'loading'` or
 * `'reconnecting'` state. The `quiescent` store emits `true` when this
 * counter is zero (no stream is fetching or recovering), and `false`
 * otherwise. A multi-stream page can drop a single loading spinner at
 * the moment all streams have settled, instead of flickering one
 * spinner per stream.
 *
 * Streams self-register in their first-subscribe path (when
 * `fetchAndSubscribe` runs) and self-deregister on cleanup or on
 * settling (`'connected'` / `'error'`).
 */
let _inFlightCount = 0;
const _quiescentStore = writable(true);

export function _addInFlight() {
	if (_inFlightCount++ === 0) _quiescentStore.set(false);
}
export function _removeInFlight() {
	if (_inFlightCount === 0) return;
	if (--_inFlightCount === 0) _quiescentStore.set(true);
}

/**
 * Reactive store that emits `true` when every active stream has
 * finished loading (or errored) and `false` while at least one is
 * fetching or recovering. Initial value is `true` (no streams yet).
 *
 * Useful for rendering a single page-level loading state instead of
 * per-stream spinners, and for detecting "all streams have caught up
 * after a reconnect" - watch for a `false -> true` transition while
 * the adapter's connection status is `'open'`.
 *
 * @type {import('svelte/store').Readable<boolean>}
 */
export const quiescent = { subscribe: _quiescentStore.subscribe };

/**
 * Reset quiescence tracking. Tests only.
 * @internal
 */
export function _resetQuiescence() {
	_inFlightCount = 0;
	_quiescentStore.set(true);
}

/**
 * System health tracking. Subscribes to the `__realtime` system topic
 * on first consumer of the `health` store and translates server-side
 * `degraded` / `recovered` events into a two-state Readable. The
 * extensions package's pub/sub bus publishes these events when its
 * circuit breaker trips and recovers; the realtime client surfaces
 * them so apps can render a "real-time updates paused" banner without
 * wiring the topic by hand.
 */
const _HEALTH_TOPIC = '__realtime';
const _healthStore = writable(/** @type {'healthy' | 'degraded' | 'outdated'} */ ('healthy'));
/** @type {(() => void) | null} */
let _healthUnsub = null;

// Sticky protocol-staleness latch. Unlike the degraded/recovered inputs (which
// toggle), 'outdated' is permanent for the session - the client is running a stale
// bundle against a newer server and must reload - so once set it short-circuits the
// recompute and never clears until the page reloads (or a test reset).
let _healthOutdated = false;
// One dev warn per session for protocol staleness (it is a global condition, not
// per-path like deprecation).
let _protocolStaleWarned = false;

// Three independent inputs OR into the single health state: a server-pushed
// degraded/recovered event on the system topic, the connection's local
// internal flow-control pressure (a queued/refused flow-controlled send), and
// smoothed-entity prediction loss (a smooth view whose un-acked command
// window overflowed because the server stopped acknowledging). Tracked
// separately so no input clobbers another - health is degraded while ANY is
// degraded, healthy only when ALL are clear.
let _healthServerDegraded = false;
let _healthFlowDegraded = false;
/** Smooth views currently in prediction-killed recovery. Counted (not a
 * boolean) because several entities can overflow and recover independently. */
let _healthSmoothDegraded = 0;
/** Document replicas whose last sync exchange failed and is retrying.
 * Counted because several documents can degrade and recover independently. */
let _healthCrdtDegraded = 0;

/**
 * Richer companion to `health`: the server-pushed degradation detail. `active`
 * mirrors the server `degraded` / `recovered` events; `mitigation` carries the
 * precomputed client action (`bannerCopy`, `retryAfterMs`, `streams` / `rpcs` to
 * treat as unavailable) while degraded; `recovery` carries any recovered-event hint
 * (`refetch` / `clearCache`). `health` stays a plain string, so this is additive.
 * @type {import('svelte/store').Writable<{ active: boolean, mitigation: any, recovery: any }>}
 */
const _degradationStore = writable({ active: false, mitigation: null, recovery: null });

function _recomputeHealth() {
	// 'outdated' is sticky and wins over the transient degraded/healthy axis: a stale
	// bundle stays flagged regardless of breaker/flow/smooth/crdt state.
	if (_healthOutdated) { _healthStore.set('outdated'); return; }
	_healthStore.set(
		_healthServerDegraded || _healthFlowDegraded || _healthSmoothDegraded > 0 || _healthCrdtDegraded > 0 ? 'degraded' : 'healthy'
	);
}

/**
 * One-shot dev console warning that the client bundle is older than the server's
 * declared protocol version. Mirrors the live.deprecate dev-warn contract (once per
 * session, dev-only); production builds strip it.
 * @param {any} detail - the protocol-stale event data ({ server, client })
 */
function _warnProtocolStale(detail) {
	if (!_IS_DEV || _protocolStaleWarned) return;
	_protocolStaleWarned = true;
	const s = detail && typeof detail.server === 'number' ? detail.server : '?';
	const c = detail && typeof detail.client === 'number' ? detail.client : '?';
	console.warn(
		'[svelte-realtime] this client is running an outdated bundle (protocol v' + c +
		') against a newer server (protocol v' + s + '). Reload to get the latest client.\n' +
		'  See: https://svti.me/protocol-stale'
	);
}

/**
 * Fold one smooth view's prediction-loss transition into the health state.
 * A boolean is the only thing that crosses this accessor, mirroring the
 * flow-control input above.
 * @param {boolean} degraded
 * @internal
 */
export function _setSmoothDegraded(degraded) {
	_healthSmoothDegraded += degraded ? 1 : -1;
	if (_healthSmoothDegraded < 0) _healthSmoothDegraded = 0;
	_recomputeHealth();
}

/**
 * Fold one document replica's sync-failure transition into the health state.
 * Same boolean-transition contract as the smooth input.
 * @param {boolean} degraded
 * @internal
 */
export function _setCrdtDegraded(degraded) {
	_healthCrdtDegraded += degraded ? 1 : -1;
	if (_healthCrdtDegraded < 0) _healthCrdtDegraded = 0;
	_recomputeHealth();
}

/**
 * Apply a system-topic health event. Extracted so it can run AFTER the de-herd
 * deferral below: a `degraded` event the server pushed with `{ jitterMs }` carries a
 * `j` window, and the consumer must stagger like every other client (else the banner
 * and the app's reaction fire at t+0, defeating the proactive mitigation push). Reads
 * the optional `mitigation` / `recovery` block a degradation policy attached.
 * @param {any} envelope
 */
function _applyHealthEvent(envelope) {
	if (!envelope) return;
	// The degradation policy attaches the mitigation / recovery inside the event
	// DATA (`publish(systemChannel, 'degraded', { at, mitigation })`), so read it
	// from `envelope.data`, not the top level. The de-herd window `j` is separate
	// frame metadata the dispatcher already consumed before this runs.
	const detail = envelope.data && typeof envelope.data === 'object' ? envelope.data : null;
	if (envelope.event === 'degraded') {
		_healthServerDegraded = true;
		_degradationStore.set({ active: true, mitigation: (detail && detail.mitigation) || null, recovery: null });
		_recomputeHealth();
	} else if (envelope.event === 'recovered') {
		_healthServerDegraded = false;
		_degradationStore.set({ active: false, mitigation: null, recovery: (detail && detail.recovery) || null });
		_recomputeHealth();
	} else if (envelope.event === 'protocol-stale') {
		// The server told THIS connection its bundle is older than the server's
		// protocol version. Sticky: latch 'outdated' and warn once. Never clears for
		// the session - the app must reload to pick up a compatible client.
		_healthOutdated = true;
		_recomputeHealth();
		_warnProtocolStale(detail);
	}
}

export function _ensureHealthSubscription() {
	if (_healthUnsub) return;
	// Route the system topic through the de-herd dispatcher so a `degraded` event the
	// server pushed with a jitter window staggers this client's reaction instead of
	// firing at t+0. A non-jittered event dispatches immediately (unchanged).
	const jitter = createJitterDispatch(_applyHealthEvent);
	const offTopic = on(_HEALTH_TOPIC).subscribe((envelope) => { if (envelope) jitter.dispatch(envelope); });
	// Fold the connection's internal flow-control health in as a second,
	// OR-ed input. A boolean is the only thing that crosses this accessor;
	// no internal accounting value surfaces. Older adapter connections that
	// predate the accessor simply do not contribute this input.
	let offFlow = () => {};
	try {
		const conn = _connect();
		if (conn && typeof conn._onLeaseDegraded === 'function') {
			offFlow = conn._onLeaseDegraded((d) => { _healthFlowDegraded = !!d; _recomputeHealth(); });
		}
	} catch { /* connection not configured yet; flow health stays clear */ }
	_healthUnsub = () => { offTopic(); jitter.clear(); offFlow(); };
}

/**
 * Reactive store reflecting the realtime system health, sourced from
 * `degraded` / `recovered` events published on the `__realtime`
 * topic by the extensions pub/sub bus's circuit breaker. Initial
 * value is `'healthy'`; flips to `'degraded'` on a `degraded` event,
 * back to `'healthy'` on `recovered`.
 *
 * Also emits the sticky `'outdated'` state when the server sends a
 * `protocol-stale` notice (the client bundle is older than the server's
 * declared `protocolVersion`). `'outdated'` is permanent for the session and
 * takes precedence over the transient `'degraded'`/`'healthy'` axis - the app
 * must reload to pick up a compatible client. Off unless `configure({
 * protocolVersion })` opted in.
 *
 * Subscription is lazy: the realtime client subscribes to `__realtime`
 * the first time any consumer subscribes to this store. Apps that
 * never read `health` pay no cost for the subscription.
 *
 * The store deliberately exposes only the state, not the underlying
 * payload. Apps that need richer detail (reason strings, timestamps,
 * etc.) can listen to the topic directly via
 * `import { on } from 'svelte-adapter-uws/client'; on('__realtime')`.
 *
 * @type {import('svelte/store').Readable<'healthy' | 'degraded' | 'outdated'>}
 */
export const health = {
	subscribe(fn) {
		_ensureHealthSubscription();
		return _healthStore.subscribe(fn);
	}
};

/**
 * Richer companion to `health`: the server-pushed degradation detail, from the same
 * `degraded` / `recovered` system events. `{ active, mitigation, recovery }` - `active`
 * tracks the SERVER breaker state (not the local flow / smooth / crdt inputs that also
 * move `health`); `mitigation` is the precomputed client action a degradation policy
 * attached (banner copy, retry-after, unavailable streams / rpcs) while degraded;
 * `recovery` is the recovered-event hint. Lazy + additive - apps that only need the
 * on/off state keep using `health`. When the degraded event was pushed with a jitter
 * window, this store updates after this client's local de-herd delay.
 *
 * @type {import('svelte/store').Readable<{ active: boolean, mitigation: any, recovery: any }>}
 */
export const degradation = {
	subscribe(fn) {
		_ensureHealthSubscription();
		return _degradationStore.subscribe(fn);
	}
};

/**
 * Reset the health store and detach the system-topic subscription.
 * Tests only.
 * @internal
 */
export function _resetHealth() {
	if (_healthUnsub) {
		_healthUnsub();
		_healthUnsub = null;
	}
	_healthServerDegraded = false;
	_healthFlowDegraded = false;
	_healthSmoothDegraded = 0;
	_healthCrdtDegraded = 0;
	_healthOutdated = false;
	_protocolStaleWarned = false;
	_healthStore.set('healthy');
	_degradationStore.set({ active: false, mitigation: null, recovery: null });
}

// Flow control is owned end to end by the adapter connection's send gate: it
// advertises the capability, paces its own flow-controlled sends against the
// server's window, and reports a single degraded boolean. The realtime layer
// consumes that boolean through conn._onLeaseDegraded in
// _ensureHealthSubscription above and ORs it into realtime.health. There is no
// realtime-owned mirror of the gate - a second copy would only drift.
