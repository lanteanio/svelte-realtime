// @ts-check
//
// `live.alarm`: per-room durable alarm primitive. A stream/room
// declares `{ alarm: { onAlarm } }`; a handler arms the room's single pending
// alarm with `ctx.setAlarm(at)`. When `at` arrives the framework rebuilds a fresh
// server ctx (no ws - the room may be empty) and runs `onAlarm`, even if everyone
// disconnected. Mirrors the cron engine's scheduler/leader/drain shape; durability
// + cluster single-fire ride a pluggable store seam (in-memory default; the
// extensions Postgres/Redis store is the follow-up layer), exactly like
// `live.idempotent({ store })` / `live.lock({ lock })`.
//
// Design: __plans/0.6/b1-live-alarm-design.md

import { state } from './state.js';
import { _IS_DEV } from './env.js';
import { wallEpoch, setTimer, clearTimer } from '../shared/runtime.js';
import { _isShuttingDown, _enterInFlight, _exitInFlight } from './lifecycle.js';
import { _getCtxHelpers, _buildCtx } from './ctx.js';
import { LiveError } from './live-error.js';

/**
 * Per-room pending alarms (the in-memory store). One entry per room, keyed by the
 * WIRE topic (already tenant-scoped, so two tenants' same logical room never
 * collide). `setAlarm` replaces the entry.
 * @type {Map<string, { at: number, timer: any, onAlarm: Function }>}
 */
const _pending = new Map();

/** Cap on concurrently-pending alarms so a runaway setAlarm-per-unique-topic can't exhaust memory. */
const _MAX_ALARMS = 100000;
let _alarmCapWarnFired = false;
let _alarmPlatformWarnFired = false;

/**
 * Optional durable store seam (default null = in-memory live timers). A durable
 * store persists `{topic, at}` so alarms survive a restart and fire once
 * cluster-wide; set it via `configureAlarm({ store })`. The realtime layer stays
 * cluster-agnostic - the durable Postgres/Redis store is the extensions layer.
 * @type {{ set: (topic: string, at: number) => any, get: (topic: string) => any, delete: (topic: string) => any } | null}
 */
let _alarmStore = null;

/**
 * Optional leader gate (default null = every instance fires its own in-memory
 * alarms, correct for single-instance). With a durable store + a leader, only the
 * elected instance fires. Mirrors `configureCron({ leader })`.
 * @type {(() => boolean) | null}
 */
let _alarmLeader = null;

/**
 * Configure the alarm subsystem. `store` plugs a durable cluster store into the
 * seam; `leader` gates firing to one instance. Both optional; `null` clears both.
 *
 * @param {{ store?: { set: Function, get: Function, delete: Function } | null, leader?: (() => boolean) | null } | null} config
 */
export function configureAlarm(config) {
	if (config === null) { _alarmStore = null; _alarmLeader = null; return; }
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] configureAlarm: config must be an object or null');
	}
	if (config.store === undefined && config.leader === undefined) {
		throw new Error('[svelte-realtime] configureAlarm: config must include at least one of store or leader');
	}
	if (config.store !== undefined) {
		if (config.store !== null && (typeof config.store !== 'object' || typeof config.store.set !== 'function' || typeof config.store.delete !== 'function')) {
			throw new Error('[svelte-realtime] configureAlarm: store must implement set(topic, at) and delete(topic)');
		}
		_alarmStore = config.store;
	}
	if (config.leader !== undefined) {
		if (config.leader !== null && typeof config.leader !== 'function') {
			throw new Error('[svelte-realtime] configureAlarm: leader must be a function or null');
		}
		_alarmLeader = config.leader;
	}
}

/**
 * Bind the alarm helpers onto a ctx for an alarm-enabled stream/room handler.
 * Shadows ctx.setAlarm/getAlarm/deleteAlarm with closures bound to the room's wire
 * topic + onAlarm handler, so the handler can arm/read/cancel the room's single
 * pending alarm. The ctx is per-call, so no restore is needed (mirrors the
 * ctx.compensate shadow lifecycle).
 * @param {any} ctx
 * @param {{ wireTopic: string, onAlarm: Function }} binding
 */
export function _bindAlarmCtx(ctx, binding) {
	const { wireTopic, onAlarm } = binding;
	ctx.setAlarm = (at) => _setAlarm(wireTopic, at, onAlarm);
	ctx.getAlarm = () => _getAlarm(wireTopic);
	ctx.deleteAlarm = () => _deleteAlarm(wireTopic);
}

function _setAlarm(wireTopic, at, onAlarm) {
	if (typeof at !== 'number' || !Number.isFinite(at)) {
		throw new LiveError('VALIDATION', '[svelte-realtime] ctx.setAlarm(at): at must be a finite epoch-ms number');
	}
	const existing = _pending.get(wireTopic);
	if (existing) {
		// Exactly one pending alarm per room: cancel and replace.
		clearTimer(existing.timer);
	} else if (_pending.size >= _MAX_ALARMS) {
		if (!_alarmCapWarnFired) {
			_alarmCapWarnFired = true;
			console.warn(
				'[svelte-realtime] alarm registry reached MAX_ALARMS=' + _MAX_ALARMS +
				'; new alarms are dropped until existing ones fire or are deleted.\n' +
				'  This usually means setAlarm is being called with an unbounded set of distinct room topics.'
			);
		}
		return;
	}
	_pending.set(wireTopic, { at, timer: _schedule(wireTopic, at), onAlarm });
	// Durable store (when wired): persist so the alarm survives a restart + fires
	// once cluster-wide. Best-effort - the in-memory timer is the live path.
	if (_alarmStore) { try { _alarmStore.set(wireTopic, at); } catch { /* best-effort */ } }
}

/**
 * `setTimeout` stores its delay in a 32-bit int: any delay greater than this (~24.85
 * days) is clamped to 1ms and fires almost immediately. A TTL-cleanup alarm (days
 * to weeks - the headline use case) is exactly that range, so we must NOT arm a
 * single long timer.
 */
const _MAX_TIMER_DELAY_MS = 2147483647;

/**
 * Arm the next timer toward the ABSOLUTE deadline `at`. When the remaining time
 * fits in one `setTimeout`, this is the final timer that runs `_fire`. When it is
 * longer, we arm a capped hop that re-checks the remaining time on wake and
 * re-arms (chasing the deadline in <= 24.8-day hops), firing `onAlarm` only on the
 * final hop. The remaining time is read from the EXACT wall clock (`wallEpoch`,
 * not the 1Hz-cached `now`) so the delay is accurate to the millisecond. A
 * past/<=now `at` fires on the next tick (clamped to 0) - "fire ASAP" is a valid
 * intent, not an error.
 * @returns {any} the timer handle
 */
function _schedule(wireTopic, at) {
	const remaining = at - wallEpoch();
	const long = remaining > _MAX_TIMER_DELAY_MS;
	const timer = setTimer(
		long ? () => _hop(wireTopic) : () => _fire(wireTopic),
		long ? _MAX_TIMER_DELAY_MS : Math.max(0, remaining)
	);
	if (timer && timer.unref) timer.unref();
	return timer;
}

/**
 * A long-deadline hop woke up: re-arm toward the SAME absolute deadline (another
 * capped hop, or the final fire when the remaining time now fits in one timer).
 * The entry's `at` is unchanged; only its timer handle advances.
 */
function _hop(wireTopic) {
	if (_isShuttingDown()) return;
	const entry = _pending.get(wireTopic);
	if (!entry) return; // deleted / replaced while hopping
	entry.timer = _schedule(wireTopic, entry.at);
}

function _getAlarm(wireTopic) {
	const e = _pending.get(wireTopic);
	return e ? e.at : null;
}

function _deleteAlarm(wireTopic) {
	const e = _pending.get(wireTopic);
	if (e) { clearTimer(e.timer); _pending.delete(wireTopic); }
	if (_alarmStore) { try { _alarmStore.delete(wireTopic); } catch { /* best-effort */ } }
}

async function _fire(wireTopic) {
	// Graceful shutdown: stop firing so the in-flight drain can finish. An
	// in-memory alarm is lost on shutdown regardless (a durable store re-fires it
	// after restart), so skipping is consistent.
	if (_isShuttingDown()) return;

	const entry = _pending.get(wireTopic);
	if (!entry) return; // already deleted / fired (race with deleteAlarm or a re-set)
	// One-shot: remove the in-memory entry + cancel its (already-fired) timer FIRST,
	// regardless of leadership - so a re-setAlarm inside onAlarm arms a fresh entry
	// rather than being clobbered, AND a non-leader whose local timer fired does not
	// leave a stale entry behind (the leader fires from the durable store instead).
	_pending.delete(wireTopic);
	clearTimer(entry.timer);

	// Cluster leader gate: with a durable store + leader, only the elected instance
	// runs the handler. Single-instance (no leader) always fires. A throwing leader
	// fails closed (skip) - better to miss one fire than to double-fire.
	if (_alarmLeader !== null) {
		let isLeader;
		try { isLeader = _alarmLeader(); }
		catch (err) {
			if (_IS_DEV) console.error('[svelte-realtime] configureAlarm leader threw; skipping alarm fire:', err);
			return;
		}
		if (!isLeader) return;
	}

	// The firing instance owns the durable record: claim-and-delete so it cannot be
	// re-fired by another instance's poll.
	if (_alarmStore) { try { _alarmStore.delete(wireTopic); } catch { /* best-effort */ } }

	const platform = state.cronPlatform;
	if (!platform) {
		if (_IS_DEV && !_alarmPlatformWarnFired) {
			_alarmPlatformWarnFired = true;
			console.warn('[svelte-realtime] alarm fired but no platform captured. Wire setCronPlatform(platform) from your hooks.ws.js init({ platform }) hook.');
		}
		return;
	}

	// Count the in-flight handler so onShutdown's drain waits for it (paired with
	// the _exitInFlight in finally) - same contract as a cron tick.
	_enterInFlight();
	try {
		const _h = _getCtxHelpers(platform);
		// Fresh ws-less server ctx (the room may be empty), exactly like a cron tick.
		const ctx = _buildCtx(null, null, platform, _h, null);
		// Room-scope ctx.publish to the firing room's WIRE topic (already
		// tenant-scoped), so onAlarm publishes to its own room with `ctx.publish(event,
		// data)` - the same room-action ergonomic. Route through `_publishWire` (the
		// raw, non-prefixing publish for a topic that is ALREADY a wire topic) so a
		// pathological tenant resolver cannot double-prefix the already-scoped topic.
		ctx.publish = (event, data) => ctx._publishWire(wireTopic, event, data);
		// Re-bind the alarm helpers so onAlarm can re-arm (TTL refresh from inside the
		// handler) or cancel its own room's alarm.
		_bindAlarmCtx(ctx, { wireTopic, onAlarm: entry.onAlarm });
		await entry.onAlarm(ctx);
	} catch (err) {
		if (state.serverErrorHandler) {
			state.serverErrorHandler(wireTopic, err);
		} else if (_IS_DEV) {
			console.error('[svelte-realtime] alarm onAlarm error for "' + wireTopic + '":', err);
		}
	} finally {
		_exitInFlight();
	}
}

/**
 * Reset all alarms (clears timers + the pending map + warn-once flags). Tests +
 * HMR. The store + leader config are user-provided refs captured once per process,
 * so they are intentionally NOT cleared (mirrors `_clearCron`).
 * @internal
 */
export function _resetAlarms() {
	for (const e of _pending.values()) clearTimer(e.timer);
	_pending.clear();
	_alarmCapWarnFired = false;
	_alarmPlatformWarnFired = false;
}

/**
 * Read-only introspection: count of pending alarms (mirrors `_cronIntrospect`).
 * @returns {{ pending: number }}
 */
export function _alarmIntrospect() {
	return { pending: _pending.size };
}
