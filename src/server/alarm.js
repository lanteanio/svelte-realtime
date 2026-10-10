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
import { _getCtxHelpers, _buildPersistedCtx } from './ctx.js';
import { LiveError } from './live-error.js';
import { diagnosticErrorMessage, emitOperationalEvent } from '../shared/diagnostic.js';
import { _validTenantId, _topicInTenant } from './tenant.js';

/**
 * @typedef {{ alarmId?: string, path?: string, tenantId?: string | null }} AlarmMeta
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
 * @type {Map<string, { at: number, timer: any, onAlarm: Function, meta: AlarmMeta | null, misfireMs?: number, store?: any, generation?: string | null, epoch?: number }>}
 */
const _pending = new Map();
const _mutations = new Map();
// Mutation topics without an acknowledged local timer reserve capacity while writing.
const _reservedTopics = new Set();
const _alarmAcknowledged = Promise.resolve();
let _alarmEpoch = 0;

/** Cap on concurrently-pending alarms so a runaway setAlarm-per-unique-topic can't exhaust memory. */
const _MAX_ALARMS = 100000;
let _alarmPlatformWarnFired = false;
let _alarmDueWarnFired = false;
const _alarmUnresolvedWarned = new Set();
const _MAX_UNRESOLVED_WARNINGS = 256;

/**
 * Optional durable store seam (default null = in-memory live timers). A durable
 * store persists `{topic, at, meta}` so alarms survive a restart and fire once
 * cluster-wide; set it via `configureAlarm({ store })`. The realtime layer stays
 * cluster-agnostic - the durable Postgres/Redis store is the extensions layer.
 *
 * - `nextGeneration(topic)` reserves a never-reused ordered generation.
 * - `get(topic)` reads the current row for cancellation after restart.
 * - `set(topic, at, meta, generation)` commits only the latest reserved generation.
 * - `delete(topic, generation)` atomically removes only that generation.
 *   Both mutation results resolve after durable commit; allocation and committed
 *   watermarks survive deletion so delayed writes cannot resurrect consumed rows.
 * - `due(nowMs)` (optional) returns the alarms whose `at <= nowMs` for the recovery
 *   poll. Omit it and cross-restart recovery is disabled (a one-time dev warning) -
 *   the in-memory timers still fire while the process lives.
 * @type {{ nextGeneration: (topic: string) => any, get: (topic: string) => any, set: (topic: string, at: number, meta: AlarmMeta | null, generation: string) => any, delete: (topic: string, generation: string) => any, due?: (nowMs: number) => any } | null}
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
 * @param {{ store?: { nextGeneration: Function, get: Function, set: Function, delete: Function, due?: Function } | null, leader?: (() => boolean) | null, pollMs?: number } | null} config
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
		if (config.store !== null && (typeof config.store !== 'object' || typeof config.store.set !== 'function' || typeof config.store.delete !== 'function' || typeof config.store.nextGeneration !== 'function' || typeof config.store.get !== 'function')) {
			throw new Error('[svelte-realtime] configureAlarm: store must implement nextGeneration(topic), get(topic), set(topic, at, meta, generation) and delete(topic, generation)');
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
 * @param {{ wireTopic: string, onAlarm: Function, alarmId?: string, path?: string, tenantId?: string | null, misfireMs?: number }} binding
 */
export function _bindAlarmCtx(ctx, binding) {
	const { wireTopic, onAlarm, alarmId, path, tenantId, misfireMs } = binding;
	let meta = null;
	if (alarmId !== undefined || path !== undefined || (tenantId !== undefined && tenantId !== null)) {
		meta = {};
		if (alarmId !== undefined) meta.alarmId = alarmId;
		if (path !== undefined) meta.path = path;
		meta.tenantId = tenantId ?? null;
	}
	ctx.setAlarm = (at) => _setAlarm(wireTopic, at, onAlarm, meta, misfireMs);
	ctx.getAlarm = () => _getAlarm(wireTopic);
	ctx.deleteAlarm = () => _deleteAlarm(wireTopic);
}

function _reserveTopic(wireTopic) {
	if (_pending.has(wireTopic) || _reservedTopics.has(wireTopic)) return;
	if (_pending.size + _reservedTopics.size >= _MAX_ALARMS) {
		throw new Error('[svelte-realtime] alarm registry reached its pending alarm limit');
	}
	_reservedTopics.add(wireTopic);
}

function _releaseTopic(wireTopic) {
	if (!_pending.has(wireTopic) && _mutations.has(wireTopic)) _reservedTopics.add(wireTopic);
	else _reservedTopics.delete(wireTopic);
}

function _queueMutation(wireTopic, work) {
	_reserveTopic(wireTopic);
	const previous = _mutations.get(wireTopic);
	const result = (previous || Promise.resolve()).then(work);
	const cleanup = () => {
		if (_mutations.get(wireTopic) === tail) _mutations.delete(wireTopic);
		_releaseTopic(wireTopic);
	};
	const tail = result.then(cleanup, cleanup);
	_mutations.set(wireTopic, tail);
	return result;
}

function _validGeneration(generation) {
	return typeof generation === 'string' && /^[1-9][0-9]*$/.test(generation);
}

function _armAlarm(wireTopic, at, onAlarm, meta, misfireMs, store, generation) {
	const existing = _pending.get(wireTopic);
	if (existing) clearTimer(existing.timer);
	else if (_pending.size + _reservedTopics.size >= _MAX_ALARMS && !_reservedTopics.has(wireTopic)) {
		throw new Error('[svelte-realtime] alarm registry reached its pending alarm limit');
	}
	if (_reservedTopics.size) _reservedTopics.delete(wireTopic);
	const entry = store
		? { at, timer: null, onAlarm, meta, misfireMs, store, generation, epoch: _alarmEpoch }
		: { at, timer: null, onAlarm, meta, misfireMs };
	_pending.set(wireTopic, entry);
	entry.timer = _schedule(wireTopic, entry);
}

function _setAlarm(wireTopic, at, onAlarm, meta = null, misfireMs = undefined) {
	if (typeof at !== 'number' || !Number.isFinite(at)) {
		throw new LiveError('VALIDATION', '[svelte-realtime] ctx.setAlarm(at): at must be a finite epoch-ms number');
	}
	const store = _alarmStore;
	if (!store) {
		_armAlarm(wireTopic, at, onAlarm, meta, misfireMs, null, null);
		return _alarmAcknowledged;
	}
	const epoch = _alarmEpoch;
	return _queueMutation(wireTopic, async () => {
		const generation = await store.nextGeneration(wireTopic);
		if (!_validGeneration(generation)) throw new Error('[svelte-realtime] alarm store returned an invalid generation');
		const committed = await store.set(wireTopic, at, meta, generation);
		if (committed !== true) throw new Error('[svelte-realtime] alarm schedule was superseded before durable commit');
		if (epoch === _alarmEpoch) _armAlarm(wireTopic, at, onAlarm, meta, misfireMs, store, generation);
	});
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
function _schedule(wireTopic, entry) {
	const remaining = entry.at - wallEpoch();
	const long = remaining > _MAX_TIMER_DELAY_MS;
	const timer = setTimer(
		long ? () => _hop(wireTopic, entry) : () => _fire(wireTopic, entry),
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
function _hop(wireTopic, entry) {
	if (_isShuttingDown()) return;
	if (_pending.get(wireTopic) !== entry) return;
	entry.timer = _schedule(wireTopic, entry);
}

function _getAlarm(wireTopic) {
	const e = _pending.get(wireTopic);
	return e ? e.at : null;
}

function _deleteAlarm(wireTopic) {
	const store = _alarmStore;
	if (!store) {
		const entry = _pending.get(wireTopic);
		if (entry) { clearTimer(entry.timer); _pending.delete(wireTopic); }
		if (_mutations.size || _reservedTopics.size) _releaseTopic(wireTopic);
		return _alarmAcknowledged;
	}
	return _queueMutation(wireTopic, async () => {
		const entry = _pending.get(wireTopic);
		const row = entry?.store === store ? entry : await store.get(wireTopic);
		if (row) {
			if (!_validGeneration(row.generation)) throw new Error('[svelte-realtime] alarm store returned an invalid generation');
			const removed = await store.delete(wireTopic, row.generation);
			if (typeof removed !== 'boolean') throw new Error('[svelte-realtime] alarm store returned an invalid delete result');
		}
		if (entry && _pending.get(wireTopic) === entry) {
			clearTimer(entry.timer);
			_pending.delete(wireTopic);
		}
	});
}

async function _fire(wireTopic, entry) {
	if (_isShuttingDown()) return;
	_enterInFlight();
	try { await _fireClaim(wireTopic, entry); }
	finally { _exitInFlight(); }
}

async function _fireClaim(wireTopic, entry) {
	if (_isShuttingDown() || _pending.get(wireTopic) !== entry) return;
	if (_alarmLeader !== null && !entry.store) {
		let isLeader;
		try { isLeader = _alarmLeader(); }
		catch { isLeader = false; }
		if (!isLeader) {
			_pending.delete(wireTopic);
			_releaseTopic(wireTopic);
			return;
		}
	}
	if (entry.store) {
		let claimed;
		try { claimed = await entry.store.delete(wireTopic, entry.generation); }
		catch {
			// Keep the row and retry its exact generation; never fire without a claim.
			if (_pending.get(wireTopic) === entry && entry.epoch === _alarmEpoch) {
				entry.timer = setTimer(() => _fire(wireTopic, entry), _alarmPollMs);
				entry.timer?.unref?.();
			}
			return;
		}
		if (claimed !== true) {
			if (_pending.get(wireTopic) === entry) _pending.delete(wireTopic);
			_releaseTopic(wireTopic);
			return;
		}
	}
	if (_pending.get(wireTopic) === entry) _pending.delete(wireTopic);
	clearTimer(entry.timer);
	_releaseTopic(wireTopic);

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

function _alarmTenant(wireTopic, meta) {
	const tenantId = meta?.tenantId == null ? null : _validTenantId(meta.tenantId);
	if (!_topicInTenant(tenantId, wireTopic)) {
		throw new LiveError('VALIDATION', '[svelte-realtime] alarm tenant metadata must match its wire topic');
	}
	return tenantId;
}

/**
 * Build a fresh ws-less server ctx for the room and run its `onAlarm`. Shared by
 * the precise in-memory timer (`_fire`) and the cross-restart recovery poll
 * (`_pollAlarms`); the caller has already claimed the alarm (one-shot / store
 * claim) and owns in-flight accounting through callback completion. This helper
 * reconstructs ctx and isolates handler errors, like a cron tick.
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

	try {
		const _h = _getCtxHelpers(platform);
		// Fresh ws-less server ctx (the room may be empty), exactly like a cron tick.
		const ctx = _buildPersistedCtx(platform, _h, _alarmTenant(wireTopic, meta));
		// Room-scope ctx.publish to the firing room's WIRE topic (already
		// tenant-scoped), so onAlarm publishes to its own room with `ctx.publish(event,
		// data)` - the same room-action ergonomic. Route through `_publishWire` (the
		// raw, non-prefixing publish for a topic that is ALREADY a wire topic) so a
		// pathological tenant resolver cannot double-prefix the already-scoped topic.
		ctx.publish = (event, data) => ctx._publishWire(wireTopic, event, data, { seq: false });
		// Re-bind the alarm helpers so onAlarm can re-arm (TTL refresh from inside the
		// handler) or cancel its own room's alarm - carrying the same resolver meta so
		// a re-armed alarm stays recoverable across a restart, and the same misfire
		// policy so a re-armed alarm keeps it.
		_bindAlarmCtx(ctx, { wireTopic, onAlarm, alarmId: meta ? meta.alarmId : undefined, path: meta ? meta.path : undefined, tenantId: meta ? meta.tenantId : undefined, misfireMs: fire ? fire.misfireMs : undefined });
		if (fire) {
			ctx.alarm = Object.freeze({ at: fire.at, firedAt: fire.firedAt, lateMs: fire.lateMs, recovered: fire.recovered });
		}
		await onAlarm(ctx);
	} catch (err) {
		if (state.serverErrorHandler) {
			try { state.serverErrorHandler(wireTopic, err); } catch { /* observer-only */ }
		}
		emitOperationalEvent({
			source: 'svelte-realtime',
			component: 'server.alarm',
			event: 'alarm.execution.failed',
			severity: 'error',
			dataClass: 'application',
			message: 'An alarm handler failed; the scheduler remains active.',
			attributes: { topic: wireTopic, error: diagnosticErrorMessage(err) }
		});
	}
}

/**
 * Recovery poll: the leader sweeps the durable store for alarms whose deadline has
 * passed but whose owning instance never fired them (it restarted/crashed before
 * its in-memory timer ran, so no `_pending` entry exists anywhere). For each, it
 * re-resolves `onAlarm` from the registry by the persisted RPC path, claims the row
 * atomically, and fires. Generations still live in `_pending` are skipped - the
 * owner's precise timer fires those. Mirrors `cron-engine._tickCron`'s leader gate + lazy
 * resolution + in-flight drain.
 */
export async function _pollAlarms() {
	if (_isShuttingDown()) return;
	_enterInFlight();
	try { await _pollAlarmRows(); }
	finally { _exitInFlight(); }
}

async function _pollAlarmRows() {
	if (_isShuttingDown()) return;
	const store = _alarmStore;
	if (!store || typeof store.due !== 'function') return;
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
	try { due = await store.due(wallEpoch()); }
	catch (err) {
		if (_IS_DEV) console.error('[svelte-realtime] alarm store due() failed; skipping poll:', err);
		return;
	}
	if (!Array.isArray(due) || due.length === 0) return;

	for (const row of due) {
		if (_isShuttingDown()) return;
		const wireTopic = row && row.topic;
		if (typeof wireTopic !== 'string' || !_validGeneration(row.generation)) continue;
		// The owner's live timer fires this one precisely - don't race it from the poll.
		const local = _pending.get(wireTopic);
		if (local?.store === store && local.generation === row.generation) continue;
		const meta = (row && row.meta) || null;
		// Invalid persisted scope must never consume a row or run in another tenant.
		try { _alarmTenant(wireTopic, meta); }
		catch { continue; }
		const path = meta && meta.path;
		const alarmId = meta && meta.alarmId;
		let fn;
		let duplicateId = false;
		if (typeof alarmId === 'string') {
			for (const candidate of registry.values()) {
				const options = /** @type {any} */ (candidate)?.__streamOptions?.alarm;
				if (!options || options.id !== alarmId) continue;
				if (fn && fn !== candidate) { duplicateId = true; break; }
				fn = candidate;
			}
		}
		// Rows written before stable ids were staged have no alarmId and keep
		// their legacy path resolver. Once a row carries an id, that identity is
		// authoritative: falling back to a reused path when the id is absent in
		// this release could execute retained work in the wrong handler.
		if (typeof alarmId !== 'string' && typeof path === 'string') fn = registry.get(path);
		const alarmOpts = fn && /** @type {any} */ (fn).__streamOptions
			&& /** @type {any} */ (fn).__streamOptions.alarm;
		const onAlarm = alarmOpts && alarmOpts.onAlarm;
		// Never consume an alarm this release cannot resolve. That preserves the row
		// for a compatible worker or rollback instead of turning a path rename into
		// silent data loss. The incident/release runbook owns terminal disposition.
		if (duplicateId || typeof onAlarm !== 'function') {
			const identity = typeof alarmId === 'string' ? 'id:' + alarmId : 'path:' + String(path);
			if (_alarmUnresolvedWarned.size < _MAX_UNRESOLVED_WARNINGS && !_alarmUnresolvedWarned.has(identity)) {
				_alarmUnresolvedWarned.add(identity);
				emitOperationalEvent({
					source: 'svelte-realtime',
					component: 'server.alarm',
					event: 'alarm.recovery.unresolved',
					severity: 'error',
					dataClass: 'code',
					message: 'A durable alarm could not be resolved by this release and was retained.',
					attributes: {
						alarmId: alarmId ?? null,
						path: path ?? null,
						reason: duplicateId ? 'duplicate-id'
							: typeof alarmId === 'string' ? 'missing-id' : 'missing-handler'
					}
				});
			}
			continue;
		}
		// Claim only after a unique resolver exists. Atomic delete still arbitrates
		// the recovery poll against the precise timer and other workers.
		let claimed;
		try { claimed = await store.delete(wireTopic, row.generation); }
		catch { continue; }
		if (claimed !== true) continue; // another poller / the owner's timer won the claim
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
	_alarmEpoch++;
	_mutations.clear();
	_reservedTopics.clear();
	for (const e of _pending.values()) clearTimer(e.timer);
	_pending.clear();
	_clearAlarmPoll();
	_alarmPlatformWarnFired = false;
	_alarmDueWarnFired = false;
	_alarmUnresolvedWarned.clear();
}

/**
 * Read-only introspection: count of pending alarms (mirrors `_cronIntrospect`).
 * @returns {{ pending: number }}
 */
export function _alarmIntrospect() {
	return { pending: _pending.size };
}
