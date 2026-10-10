// @ts-check
//
// Process lifecycle: graceful-shutdown drain + in-flight accounting.
//
// The adapter owns the shutdown signal (SIGTERM) and calls the ws-hooks
// `shutdown({ platform })` hook ONCE, before it closes the listen socket and
// flushes the open WebSockets (`ws.end(1001)`). `realtime()` wires its own
// `shutdown` into that hook, so a graceful deploy drains in-flight work before
// any socket is cut.
//
// Two cooperating pieces:
//   - an in-flight counter the dispatch funnels (text/binary RPC, SSR
//     direct-call) and the cron tick increment around handler execution;
//   - a "shutting down" gate the same funnels read to reject NEW work with
//     `UNAVAILABLE` once a drain has begun.
//
// On shutdown: raise the gate (new work rejected), stop the cron scheduler +
// the stale-reload watchdogs (no new background work), wait for the in-flight
// count to reach zero or the drain budget to elapse, then run the registered
// teardown handlers in order. The in-flight drain is bounded by `drainMs`. In
// clustered mode the adapter's `SHUTDOWN_TIMEOUT` (default 30s) force-terminates
// the worker as a hard cap, so keep both the drain budget AND your handler work
// well under it; in single-process mode a handler that never resolves is the
// app's own responsibility to bound (it would otherwise hold process exit open).
//
// Zero-config: even with no `onShutdown` handler registered, the default drain
// runs, so an app gets a graceful in-flight drain for free.

import { monotonicNow, setTimer } from '../shared/runtime.js';
import { emitOperationalEvent } from '../shared/diagnostic.js';

/** @typedef {import('../server.js').ShutdownDrainResult} ShutdownDrainResult */

/** Default in-flight drain budget (ms) when no registration specifies one. */
const _DEFAULT_DRAIN_MS = 5000;
/** Poll cadence (ms) while waiting for the in-flight count to reach zero. */
const _DRAIN_POLL_MS = 25;

let _shuttingDown = false;
let _inFlight = 0;
/** @type {Array<{ handler: (ctx: { platform: any, drain: ShutdownDrainResult }) => any, drainMs: number | undefined }>} */
let _handlers = [];
/** @type {(() => void) | null} cron scheduler stop, wired once at init (no import cycle). */
let _stopScheduler = null;
/** @type {Promise<ShutdownDrainResult> | null} latched so concurrent shutdown calls share one run. */
let _shutdownPromise = null;

/**
 * Wire the cron-engine scheduler stop. Called once by server.js so this module
 * never imports cron-engine (keeps the dependency one-way: cron -> lifecycle is
 * fine, lifecycle -> cron would cycle).
 * @param {() => void} stopScheduler
 */
export function _installLifecycle(stopScheduler) {
	_stopScheduler = stopScheduler;
}

/** @returns {boolean} true once a graceful shutdown has begun. */
export function _isShuttingDown() {
	return _shuttingDown;
}

/** @returns {number} current count of in-flight server handlers. */
export function inFlightCount() {
	return _inFlight;
}

/** Mark a unit of server work as started (dispatch funnels + cron tick). */
export function _enterInFlight() {
	_inFlight++;
}

/** Mark a unit of server work as settled. Clamped so it never goes negative. */
export function _exitInFlight() {
	if (_inFlight > 0) _inFlight--;
}

/**
 * Register a teardown handler run during graceful shutdown, after in-flight
 * work has drained or exhausted its budget. Handlers run in registration order
 * and receive `{ platform, drain }`, with the immutable pre-teardown outcome. A throwing
 * handler is logged and ignored so one failure cannot abort the rest.
 *
 * `drainMs` sets the in-flight drain budget (the largest across all
 * registrations wins; default 5000ms when none specify one). Keep it well
 * under the adapter's `SHUTDOWN_TIMEOUT` (default 30s), which is the hard cap.
 *
 * @param {(ctx: { platform: any, drain: ShutdownDrainResult }) => void | Promise<void>} handler
 * @param {{ drainMs?: number }} [options]
 * @returns {() => void} unregister fn
 */
export function onShutdown(handler, options) {
	if (typeof handler !== 'function') {
		throw new Error('[svelte-realtime] onShutdown(handler): handler must be a function');
	}
	let drainMs;
	if (options !== undefined) {
		if (typeof options !== 'object' || options === null) {
			throw new Error('[svelte-realtime] onShutdown: options must be an object');
		}
		drainMs = options.drainMs;
		if (drainMs !== undefined && (typeof drainMs !== 'number' || !Number.isFinite(drainMs) || drainMs < 0)) {
			throw new Error('[svelte-realtime] onShutdown: drainMs must be a non-negative finite number');
		}
	}
	const entry = { handler, drainMs };
	_handlers.push(entry);
	return () => {
		const i = _handlers.indexOf(entry);
		if (i !== -1) _handlers.splice(i, 1);
	};
}

/**
 * Run the graceful shutdown sequence. Idempotent: a second call (or a
 * concurrent one) returns the first run's promise rather than draining twice.
 * Wired as the `realtime()` `shutdown` hook the adapter invokes on SIGTERM.
 *
 * @param {{ platform?: any }} [ctx]
 * @returns {Promise<ShutdownDrainResult>}
 */
export function _runShutdown(ctx) {
	if (_shutdownPromise) return _shutdownPromise;
	_shutdownPromise = _doShutdown(ctx || { platform: undefined });
	return _shutdownPromise;
}

/**
 * @param {{ platform?: any }} ctx
 * @returns {Promise<ShutdownDrainResult>}
 */
async function _doShutdown(ctx) {
	_shuttingDown = true; // gate up: new RPC / SSR / cron work is now rejected
	if (_stopScheduler) {
		try {
			_stopScheduler();
		} catch (err) {
			console.error('[svelte-realtime] shutdown: cron scheduler stop threw (ignored):', err);
		}
	}
	const specified = /** @type {number[]} */ (_handlers.map((h) => h.drainMs).filter((ms) => ms !== undefined));
	const budget = specified.length ? Math.max(...specified) : _DEFAULT_DRAIN_MS;
	const drain = await _drainInFlight(budget);
	try {
		emitOperationalEvent({
			source: 'svelte-realtime', component: 'server.lifecycle',
			event: drain.timedOut ? 'shutdown.drain.timed-out' : 'shutdown.drain.completed',
			severity: drain.timedOut ? 'warn' : 'info', dataClass: 'operational',
			message: drain.timedOut ? 'Shutdown drain budget expired with tracked handlers still active.' : 'Shutdown tracked handlers drained before teardown.',
			attributes: { ...drain }
		});
	} catch { /* Telemetry must not prevent teardown. */ }
	for (const { handler } of _handlers) {
		try {
			await handler(/** @type {any} */ ({ ...ctx, drain }));
		} catch (err) {
			console.error('[svelte-realtime] onShutdown handler threw (ignored):', err);
		}
	}
	return drain;
}

/**
 * Resolve when the in-flight count reaches zero or the budget elapses,
 * whichever comes first. Polls via the runtime-seam timer so a seeded sim
 * harness drives it deterministically.
 * @param {number} budgetMs
 * @returns {Promise<ShutdownDrainResult>}
 */
function _drainInFlight(budgetMs) {
	const start = monotonicNow();
	const outcome = () => Object.freeze({
		drained: _inFlight === 0, timedOut: _inFlight !== 0,
		remaining: _inFlight, elapsedMs: Math.max(0, monotonicNow() - start)
	});
	if (_inFlight === 0 || budgetMs <= 0) return Promise.resolve(outcome());
	return new Promise((resolve) => {
		const tick = () => {
			const remainingMs = budgetMs - (monotonicNow() - start);
			if (_inFlight === 0 || remainingMs <= 0) {
				resolve(outcome());
				return;
			}
			setTimer(tick, Math.min(_DRAIN_POLL_MS, remainingMs));
		};
		setTimer(tick, Math.min(_DRAIN_POLL_MS, budgetMs));
	});
}

/**
 * Reset all lifecycle state. Tests / HMR only. Clears the gate, the in-flight
 * counter, the registered handlers, and the latched shutdown promise. Does NOT
 * unwire `_installLifecycle` (the cron stop binding is process-stable).
 */
export function _resetLifecycle() {
	_shuttingDown = false;
	_inFlight = 0;
	_handlers = [];
	_shutdownPromise = null;
}
