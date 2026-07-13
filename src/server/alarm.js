// @ts-check
//
// `live.alarm`: per-room durable alarm primitive. A stream/room
// declares `{ alarm: { onAlarm } }`; a handler arms the room's single pending
// alarm with `ctx.setAlarm(at)`. When `at` arrives the framework rebuilds a fresh
// server ctx (no ws - the room may be empty) and runs `onAlarm`, even if everyone
// disconnected. Mirrors the cron engine's scheduler/leader/drain shape; durability
// + cluster single-fire ride a pluggable store seam (in-memory default; the
// extensions Postgres/Redis `createAlarmStore` is the durable layer), exactly like
// `live.idempotent({ store })` / `live.lock({ lock })`. A wired store also enables a
// leader-gated recovery poll that re-fires alarms an instance left behind on restart.

import { state, registry } from './state.js';
import { _IS_DEV } from './env.js';
import { wallEpoch, setTimer, clearTimer, setIntervalTimer, clearIntervalTimer } from '../shared/runtime.js';
import { _isShuttingDown, _enterInFlight, _exitInFlight } from './lifecycle.js';
import { _resolveAllLazy, _isLazyResolved } from './lazy.js';
import { _getCtxHelpers, _buildCtx } from './ctx.js';
import { LiveError } from './live-error.js';

/**
 * @typedef {{ path?: string, tenantId?: string | null }} AlarmMeta
 * Opaque-to-the-store resolver metadata persisted alongside `{topic, at}`. `path`
 * is the stream's RPC registry key, so a cross-restart recovery poll can re-resolve
 * `onAlarm` from `registry.get(path)` (the in-memory `onAlarm` closure is gone after
 * a restart). The durable store treats it as an opaque blob; only the realtime poll
 * interprets it.
 */

/**
 * Per-room pending alarms (the in-memory store). One entry per room, keyed by the
 * WIRE topic (already tenant-scoped, so two tenants' same logical room never
 * collide). `setAlarm` replaces the entry.
 * @type {Map<string, { at: number, timer: any, onAlarm: Function, meta: AlarmMeta | null, misfireMs?: number }>}
 */
const _pending = new Map();

/** Cap on concurrently-pending alarms so a runaway setAlarm-per-unique-topic can't exhaust memory. */
const _MAX_ALARMS = 100000;
let _alarmCapWarnFired = false;
let _alarmPlatformWarnFired = false;
let _alarmDueWarnFired = false;

/**
 * Optional durable store seam (default null = in-memory live timers). A durable
 * store persists `{topic, at, meta}` so alarms survive a restart and fire once
 * cluster-wide; set it via `configureAlarm({ store })`. The realtime layer stays
 * cluster-agnostic - the durable Postgres/Redis store is the extensions layer.
 *
 * - `set(topic, at, meta)` persists/replaces an alarm.
 * - `delete(topic)` removes it and returns whether THIS call removed a present row
 *   (the atomic claim that guarantees single-fire between the precise in-memory
 *   timer and the recovery poll).
 * - `due(nowMs)` (optional) returns the alarms whose `at <= nowMs` for the recovery
 *   poll. Omit it and cross-restart recovery is disabled (a one-time dev warning) -
 *   the in-memory timers still fire while the process lives.
 * @type {{ set: (topic: string, at: number, meta?: AlarmMeta | null) => any, delete: (topic: string) => any, due?: (nowMs: number) => any } | null}
 */
let _alarmStore = null;

/** Recovery-poll cadence in ms (the leader sweeps `store.due(now)` this often). */
let _alarmPollMs = 15000;
/** @type {any} */ let _alarmPollTimer = null;
/** @type {any} */ let _alarmStartupTimer = null;

/**
 * Optional leader gate (default null = every instance fires its own in-memory
 * alarms, correct for single-instance). With a durable store + a leader, only the
 * elected instance fires. Mirrors `configureCron({ leader })`.
 * @type {(() => boolean) | null}
 */
let _alarmLeader = null;

/**
 * Configure the alarm subsystem. `store` plugs a durable cluster store into the
 * seam; `leader` gates firing to one instance; `pollMs` sets the recovery-poll
 * cadence. All optional; `null` clears store + leader and resets the cadence.
 *
 * A store that implements `due(nowMs)` enables cross-restart recovery: the leader
 * polls `due(now)` every `pollMs` and fires any alarm an instance left behind when
 * it restarted before its in-memory timer ran. A store WITHOUT `due` still persists
 * `set`/`delete` but only the in-memory timers fire (a one-time dev warning notes
 * recovery is off). A `leader` without a `store` suppresses non-leader alarms with
 * no way to recover them - configure a store for real cluster durability.
 *
 * @param {{ store?: { set: Function, delete: Function, due?: Function } | null, leader?: (() => boolean) | null, pollMs?: number } | null} config
 */
export function configureAlarm(config) {
	if (config === null) { _alarmStore = null; _alarmLeader = null; _alarmPollMs = 15000; _clearAlarmPoll(); return; }
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] configureAlarm: config must be an object or null');
	}
	if (config.store === undefined && config.leader === undefined && config.pollMs === undefined) {
		throw new Error('[svelte-realtime] configureAlarm: config must include at least one of store or leader');
	}
	if (config.pollMs !== undefined) {
		if (typeof config.pollMs !== 'number' || !Number.isFinite(config.pollMs) || config.pollMs < 1) {
			throw new Error('[svelte-realtime] configureAlarm: pollMs must be a positive number');
		}
		_alarmPollMs = config.pollMs;
	}
	if (config.store !== undefined) {
		if (config.store !== null && (typeof config.store !== 'object' || typeof config.store.set !== 'function' || typeof config.store.delete !== 'function')) {
			throw new Error('[svelte-realtime] configureAlarm: store must implement set(topic, at) and delete(topic)');
		}
		if (config.store !== null && config.store.due !== undefined && typeof config.store.due !== 'function') {
			throw new Error('[svelte-realtime] configureAlarm: store.due, when provided, must be a function due(nowMs)');
		}
		_alarmStore = config.store;
	}
	if (config.leader !== undefined) {
		if (config.leader !== null && typeof config.leader !== 'function') {
			throw new Error('[svelte-realtime] configureAlarm: leader must be a function or null');
		}
		_alarmLeader = config.leader;
	}
	// (Re)start or stop the recovery poll to match the current store. A store with
	// `due` polls; anything else does not (and a store without `due` warns once).
	_clearAlarmPoll();
	if (_alarmStore && typeof _alarmStore.due === 'function') {
		_ensureAlarmPoll();
	} else if (_alarmStore && !_alarmDueWarnFired && _IS_DEV) {
		_alarmDueWarnFired = true;
		console.warn(
			'[svelte-realtime] configureAlarm: the wired store has no due(nowMs); cross-restart alarm recovery is disabled.\n' +
			'  In-memory timers still fire while the process lives, but alarms armed before a restart will not re-fire.\n' +
			'  Provide due(nowMs) on the store for full durability.'
		);
	}
}

/**
 * Bind the alarm helpers onto a ctx for an alarm-enabled stream/room handler.
 * Shadows ctx.setAlarm/getAlarm/deleteAlarm with closures bound to the room's wire
 * topic + onAlarm handler, so the handler can arm/read/cancel the room's single
 * pending alarm. The ctx is per-call, so no restore is needed (mirrors the
 * ctx.compensate shadow lifecycle).
 *
 * `path` (the stream's RPC registry key) + `tenantId` are captured as the durable
 * row's resolver metadata so a cross-restart recovery poll can re-find `onAlarm`
 * via `registry.get(path)` (see `_pollAlarms`). They are optional - a bare bind
 * without them keeps the in-memory path working (durability just needs the live
 * dispatch bind, which always supplies `path`).
 * @param {any} ctx
 * @param {{ wireTopic: string, onAlarm: Function, path?: string, tenantId?: string | null, misfireMs?: number }} binding
 */
export function _bindAlarmCtx(ctx, binding) {
	const { wireTopic, onAlarm, path, tenantId, misfireMs } = binding;
	const meta = (path !== undefined || (tenantId !== undefined && tenantId !== null))
		? { path, tenantId: tenantId ?? null }
		: null;
	ctx.setAlarm = (at) => _setAlarm(wireTopic, at, onAlarm, meta, misfireMs);
	ctx.getAlarm = () => _getAlarm(wireTopic);
	ctx.deleteAlarm = () => _deleteAlarm(wireTopic);
}

function _setAlarm(wireTopic, at, onAlarm, meta = null, misfireMs = undefined) {
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
	_pending.set(wireTopic, { at, timer: _schedule(wireTopic, at), onAlarm, meta, misfireMs });
	// Durable store (when wired): persist so the alarm survives a restart + fires
	// once cluster-wide. Best-effort - the in-memory timer is the live path. `meta`
	// carries the resolver path so a recovery poll can re-find onAlarm after a restart.
	if (_alarmStore) { try { _alarmStore.set(wireTopic, at, meta); } catch { /* best-effort */ } }
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

	// Cluster leader gate - applied to the PRECISE path only when there is NO
	// durable store to arbitrate. With a store, the atomic `delete`-claim below
	// already guarantees exactly one instance fires (the arming instance's precise
	// timer or the leader's recovery sweep, whichever claims the row first). Gating
	// the precise path on leadership as well would throw away on-time firing for
	// every alarm armed on a NON-leader - the majority, since clients are
	// load-balanced: its precise timer would return here, and it would fire only
	// via the leader's up-to-pollMs-late recovery sweep, or be dropped entirely
	// when misfireMs < pollMs. So with a store, let the arming instance fire
	// precisely and rely on the claim for single-fire. Without a store the
	// in-memory timer is the sole arbiter, so the discouraged leader-without-store
	// config keeps leader-only firing. A throwing leader fails closed (skip) -
	// better to miss one fire than to double-fire.
	if (_alarmLeader !== null && _alarmStore === null) {
		let isLeader;
		try { isLeader = _alarmLeader(); }
		catch (err) {
			if (_IS_DEV) console.error('[svelte-realtime] configureAlarm leader threw; skipping alarm fire:', err);
			return;
		}
		if (!isLeader) return;
	}

	// The firing instance claims the durable record atomically: `delete` returns
	// whether THIS call removed a present row. If the recovery poll already fired
	// (and claimed) it, the claim fails and we skip - this is the single-fire
	// backstop between the precise in-memory timer and the poll. A store error fails
	// OPEN (fire anyway): at-least-once is the durable-alarm contract, so onAlarm
	// must be idempotent. No store -> the local one-shot above is the sole arbiter.
	if (_alarmStore) {
		let claimed;
		try { claimed = await _alarmStore.delete(wireTopic); }
		catch { claimed = true; }
		if (!claimed) return;
	}

	// Misfire policy: with `misfireMs` set, an alarm firing later than its
	// deadline plus the threshold is dropped instead of run - AFTER the claim,
	// so the durable row is still consumed (a stale alarm is spent, not
	// re-fired forever). Default (unset) keeps fire-when-late: "fire ASAP" is
	// a valid intent for a merely-delayed timer.
	const firedAt = wallEpoch();
	const lateMs = Math.max(0, firedAt - entry.at);
	if (typeof entry.misfireMs === 'number' && lateMs > entry.misfireMs) {
		if (_IS_DEV) {
			console.warn('[svelte-realtime] alarm for "' + wireTopic + '" missed its window by ' + lateMs + 'ms (misfireMs=' + entry.misfireMs + '); skipped.');
		}
		return;
	}

	await _invokeAlarm(wireTopic, entry.onAlarm, entry.meta, { at: entry.at, firedAt, lateMs, recovered: false, misfireMs: entry.misfireMs });
}

/**
 * Build a fresh ws-less server ctx for the room and run its `onAlarm`. Shared by
 * the precise in-memory timer (`_fire`) and the cross-restart recovery poll
 * (`_pollAlarms`); the caller has already claimed the alarm (one-shot / store
 * claim), so this just reconstructs ctx and invokes the handler with in-flight
 * accounting + error isolation - the same contract as a cron tick.
 * @param {string} wireTopic
 * @param {Function} onAlarm
 * @param {AlarmMeta | null} meta
 * @param {{ at: number, firedAt: number, lateMs: number, recovered: boolean, misfireMs?: number } | null} fire
 *   Fire-time visibility surfaced to the handler as `ctx.alarm`: the scheduled
 *   deadline, when it actually ran, how late that is, and whether the recovery
 *   poll (not the precise in-memory timer) fired it. Without this, a restart-
 *   recovered alarm running hours late is indistinguishable from an on-time one.
 */
async function _invokeAlarm(wireTopic, onAlarm, meta, fire = null) {
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
		// handler) or cancel its own room's alarm - carrying the same resolver meta so
		// a re-armed alarm stays recoverable across a restart, and the same misfire
		// policy so a re-armed alarm keeps it.
		_bindAlarmCtx(ctx, { wireTopic, onAlarm, path: meta ? meta.path : undefined, tenantId: meta ? meta.tenantId : undefined, misfireMs: fire ? fire.misfireMs : undefined });
		if (fire) {
			ctx.alarm = Object.freeze({ at: fire.at, firedAt: fire.firedAt, lateMs: fire.lateMs, recovered: fire.recovered });
		}
		await onAlarm(ctx);
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
 * Recovery poll: the leader sweeps the durable store for alarms whose deadline has
 * passed but whose owning instance never fired them (it restarted/crashed before
 * its in-memory timer ran, so no `_pending` entry exists anywhere). For each, it
 * re-resolves `onAlarm` from the registry by the persisted RPC path, claims the row
 * atomically, and fires. Topics still live in `_pending` are skipped - the owner's
 * precise timer fires those. Mirrors `cron-engine._tickCron`'s leader gate + lazy
 * resolution + in-flight drain.
 */
export async function _pollAlarms() {
	if (_isShuttingDown()) return;
	if (!_alarmStore || typeof _alarmStore.due !== 'function') return;
	// Resolve lazy stream modules so `registry.get(path).__streamOptions.alarm` is
	// populated before we decide a row is stale (mirrors the cron tick).
	if (!_isLazyResolved()) await _resolveAllLazy();
	if (_isShuttingDown()) return;

	// Leader gate: exactly one instance sweeps the shared store. A throwing leader
	// fails closed (skip this tick) - the next tick retries.
	if (_alarmLeader !== null) {
		let isLeader;
		try { isLeader = _alarmLeader(); }
		catch (err) {
			if (_IS_DEV) console.error('[svelte-realtime] configureAlarm leader threw; skipping alarm poll:', err);
			return;
		}
		if (!isLeader) return;
	}

	let due;
	try { due = await _alarmStore.due(wallEpoch()); }
	catch (err) {
		if (_IS_DEV) console.error('[svelte-realtime] alarm store due() failed; skipping poll:', err);
		return;
	}
	if (!Array.isArray(due) || due.length === 0) return;

	for (const row of due) {
		if (_isShuttingDown()) return;
		const wireTopic = row && row.topic;
		if (typeof wireTopic !== 'string') continue;
		// The owner's live timer fires this one precisely - don't race it from the poll.
		if (_pending.has(wireTopic)) continue;
		const meta = (row && row.meta) || null;
		const path = meta && meta.path;
		const fn = typeof path === 'string' ? registry.get(path) : undefined;
		const alarmOpts = fn && /** @type {any} */ (fn).__streamOptions
			&& /** @type {any} */ (fn).__streamOptions.alarm;
		const onAlarm = alarmOpts && alarmOpts.onAlarm;
		// Claim the row regardless of resolvability: an atomic delete both arbitrates
		// single-fire AND garbage-collects an orphan whose stream was removed/renamed
		// (claimed but unresolvable -> drop, never accumulate).
		let claimed;
		try { claimed = await _alarmStore.delete(wireTopic); }
		catch { continue; }
		if (!claimed) continue; // another poller / the owner's timer won the claim
		if (typeof onAlarm !== 'function') continue; // stale row GC'd above; nothing to run
		// Misfire policy on the recovery path: the stream's declared threshold is
		// re-resolved from the registry (the persisted row stays policy-free). The
		// claim above already consumed the row, so a skipped stale alarm is spent.
		const at = typeof (row && row.at) === 'number' ? row.at : null;
		const firedAt = wallEpoch();
		const lateMs = at !== null ? Math.max(0, firedAt - at) : 0;
		const misfireMs = typeof alarmOpts.misfireMs === 'number' ? alarmOpts.misfireMs : undefined;
		if (at !== null && misfireMs !== undefined && lateMs > misfireMs) {
			if (_IS_DEV) {
				console.warn('[svelte-realtime] recovered alarm for "' + wireTopic + '" missed its window by ' + lateMs + 'ms (misfireMs=' + misfireMs + '); skipped.');
			}
			continue;
		}
		await _invokeAlarm(wireTopic, onAlarm, meta, { at: at !== null ? at : firedAt, firedAt, lateMs, recovered: true, misfireMs });
	}
}

/** Start the recovery poll (idempotent). Only meaningful when a store with `due` is wired. */
function _ensureAlarmPoll() {
	if (_alarmPollTimer) return;
	_alarmPollTimer = setIntervalTimer(_pollAlarms, _alarmPollMs);
	if (_alarmPollTimer && _alarmPollTimer.unref) _alarmPollTimer.unref();
	// A short startup tick so a freshly-(re)started leader recovers overdue orphans
	// promptly instead of waiting a full poll interval.
	_alarmStartupTimer = setTimer(_pollAlarms, 1000);
	if (_alarmStartupTimer && _alarmStartupTimer.unref) _alarmStartupTimer.unref();
}

/** Stop the recovery poll (clears both timers). */
function _clearAlarmPoll() {
	if (_alarmPollTimer) { clearIntervalTimer(_alarmPollTimer); _alarmPollTimer = null; }
	if (_alarmStartupTimer) { clearTimer(_alarmStartupTimer); _alarmStartupTimer = null; }
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
	_clearAlarmPoll();
	_alarmCapWarnFired = false;
	_alarmPlatformWarnFired = false;
	_alarmDueWarnFired = false;
}

/**
 * Read-only introspection: count of pending alarms (mirrors `_cronIntrospect`).
 * @returns {{ pending: number }}
 */
export function _alarmIntrospect() {
	return { pending: _pending.size };
}
