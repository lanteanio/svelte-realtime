// @ts-check
import { writable } from 'svelte/store';
import { connect as _connect, on } from 'svelte-adapter-uws/client';

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
const _healthStore = writable(/** @type {'healthy' | 'degraded'} */ ('healthy'));
/** @type {(() => void) | null} */
let _healthUnsub = null;

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

function _recomputeHealth() {
	_healthStore.set(
		_healthServerDegraded || _healthFlowDegraded || _healthSmoothDegraded > 0 || _healthCrdtDegraded > 0 ? 'degraded' : 'healthy'
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

function _ensureHealthSubscription() {
	if (_healthUnsub) return;
	const offTopic = on(_HEALTH_TOPIC).subscribe((envelope) => {
		if (!envelope) return;
		if (envelope.event === 'degraded') { _healthServerDegraded = true; _recomputeHealth(); }
		else if (envelope.event === 'recovered') { _healthServerDegraded = false; _recomputeHealth(); }
	});
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
	_healthUnsub = () => { offTopic(); offFlow(); };
}

/**
 * Reactive store reflecting the realtime system health, sourced from
 * `degraded` / `recovered` events published on the `__realtime`
 * topic by the extensions pub/sub bus's circuit breaker. Initial
 * value is `'healthy'`; flips to `'degraded'` on a `degraded` event,
 * back to `'healthy'` on `recovered`.
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
 * @type {import('svelte/store').Readable<'healthy' | 'degraded'>}
 */
export const health = {
	subscribe(fn) {
		_ensureHealthSubscription();
		return _healthStore.subscribe(fn);
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
	_healthStore.set('healthy');
}

// Flow control is owned end to end by the adapter connection's send gate: it
// advertises the capability, paces its own flow-controlled sends against the
// server's window, and reports a single degraded boolean. The realtime layer
// consumes that boolean through conn._onLeaseDegraded in
// _ensureHealthSubscription above and ORs it into realtime.health. There is no
// realtime-owned mirror of the gate - a second copy would only drift.
