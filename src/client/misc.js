// @ts-check
import { connect as _connect } from 'svelte-adapter-uws/client';
import { now, setTimer, clearTimer } from '../client-runtime.js';
import { clientState, RpcError, _offlineQueue, _IS_DEV, _isConnectionLoss } from './internal-state.js';
import { _sendRpc } from './rpc.js';
import { _conn, _closedForGoodNow, _connectionClosedError } from './connection.js';
import { _ensureHealthSubscription } from './health.js';
import { _configureOfflinePersistence, _offlineReady, _offlineScope, _startOfflineDrain, _finishOfflineDrain, _ownOfflineReplay, _keepIfStored, _isHeldAfterClose, _settlePersist, _bumpPending, _setUploading, _clearGapIfClean, _trimQueue, _batchState, _beginBatch, _noteBatchFailure, _carryBatch, _endBatch, _queueLimit, _notifyReplayError, _settleDropped, _setRetryAt, _onOfflineReset } from './offline.js';

/**
 * @typedef {{ path: string, args: any[], queuedAt: number, resolve: Function, reject: Function, idempotencyKey?: string, timeout?: number, seq?: number, expiresAt?: number, retryAt?: number, idempotencyBackoff?: number, idempotencyHeld?: number, idempotencyLastTry?: boolean, restored?: boolean }} OfflineEntry
 */

const _CONFLICT_RESOLUTIONS = new Set(['lww', 'server-win', 'custom']);

// The longest one call may hold the queue with idempotency refusals, in all.
// A refusal that names a longer wait, or one past this total, sets the call
// aside until then, and the calls behind it go ahead.
const _IDEMPOTENCY_REPLAY_HOLD_MS = 30000;
// A refusal that names no wait backs off from one second, doubling up to this.
const _IDEMPOTENCY_BACKOFF_MAX_MS = 300000;

// A wait cut short by the retention retries up to this long before it ends
// (half the time left, if that is less), so a timer that fires a few seconds
// late (a background tab) still finds the call in it.
const _LAST_TRY_MARGIN_MS = 5000;

/** A queued call set aside until its `retryAt`. */
const _waiting = (entry, at) => entry.retryAt !== undefined && entry.retryAt > at;

/**
 * Whether a queued call is past its retention at `at`.
 * @param {OfflineEntry} entry @param {number} at @param {number} maxAge
 */
const _expiredAt = (entry, at, maxAge) => (maxAge > 0 && at - entry.queuedAt > maxAge) || (entry.expiresAt !== undefined && entry.expiresAt <= at);

/**
 * The last moment a queued call is still within its retention.
 * @param {OfflineEntry} entry @param {number} maxAge
 */
const _lastLegalAt = (entry, maxAge) => Math.min(maxAge > 0 ? entry.queuedAt + maxAge : Infinity, entry.expiresAt !== undefined ? entry.expiresAt - 1 : Infinity);

/**
 * When a call that runs out of retention gets its last try, as seen at `at`.
 * @param {OfflineEntry} entry @param {number} maxAge @param {number} at
 */
const _lastTryAt = (entry, maxAge, at) => {
	const last = _lastLegalAt(entry, maxAge);
	return last - Math.min(_LAST_TRY_MARGIN_MS, Math.floor((last - at) / 2));
};

// The longest delay a timer can take; a later drain re-arms for the rest.
const _MAX_TIMER_MS = 2147483647;

/** @type {{ handle: any, at: number, early: boolean } | null} The one pending re-drain of the queue. */
let _redrain = null;

/**
 * No full re-drain of `scope` before `at` (wall ms): the latest backoff or
 * server hint a refusal asked the queue head to wait. Until then a drain
 * replays only set-aside calls that are due, so the head is never retried
 * early, and a wake comes sooner only for a set-aside call that would expire
 * by then.
 * @type {{ scope: any, at: number }}
 */
let _redrainNotBefore = { scope: null, at: 0 };

/** @param {any} scope */
const _floorOf = (scope) => _redrainNotBefore.scope === scope ? _redrainNotBefore.at : 0;

/**
 * Whether a set-aside call due by `at` would expire before `floorAt`, the end
 * of the latest backoff: it may go up ahead of the held head.
 * @param {OfflineEntry} entry @param {number} at @param {number} floorAt
 * @param {number} maxAge
 */
const _urgent = (entry, at, floorAt, maxAge) => entry.retryAt !== undefined && entry.retryAt <= at && entry.retryAt < floorAt && _expiredAt(entry, floorAt, maxAge);

/**
 * Drain the current queue again after `delay` ms, unless a pending re-drain
 * comes sooner. No sooner than the latest backoff unless `early`. Only while
 * connected: the next open drains anyway.
 * @param {number} delay @param {boolean} [early]
 */
function _scheduleRedrain(delay, early = false) {
	if (clientState.isOffline || clientState.terminated) return;
	const floor = _floorOf(_offlineScope());
	const at = Math.max(now() + delay, early ? 0 : floor);
	delay = at - now();
	if (_redrain !== null) {
		// A wake armed before the latest backoff moves out to its end. A drain
		// before then sends only urgent set-aside calls, which is what keeps
		// the held head back; this saves the drain that would find none.
		if (_redrain.at <= at && (_redrain.early || _redrain.at >= floor)) return;
		clearTimer(_redrain.handle);
	}
	_redrain = { at, early, handle: setTimer(() => {
		_redrain = null;
		if (_redrainNotBefore.at <= now()) _redrainNotBefore = { scope: null, at: 0 };
		void _drainOfflineQueue();
	}, Math.min(_MAX_TIMER_MS, delay)) };
}

function _cancelRedrain() {
	_redrainNotBefore = { scope: null, at: 0 };
	if (_redrain === null) return;
	clearTimer(_redrain.handle);
	_redrain = null;
}
_onOfflineReset(_cancelRedrain);

/** @type {boolean} */
let _configListenerAttached = false;

/** The active drain belongs to one queue scope. Older in-flight RPCs settle separately. */
let _replayingScope = null;

/**
 * Configure client-side connection hooks, RPC timeout, stream resume
 * grace window, and offline queue.
 *
 * `resumeGraceMs` (default 60000) controls how long a stream retains its
 * data model after the last subscriber unsubs. A new subscribe within the
 * window resumes from the retained seq/version/cursor so the server can
 * gap-fill instead of cold-rehydrating. Set to 0 to disable.
 *
 * `resumeMaxCursorAgeMs` (default 60000) bounds how long a still-subscribed
 * stream trusts its retained replay cursor across a reconnect. A brief socket
 * bounce resumes from the retained seq (the server gap-fills); after an outage
 * longer than this - a backgrounded tab, a device sleep, a tunnel drop - the
 * stream drops the cursor and takes a full rehydrate, since the server may
 * have pruned data by time in a way the seq alone does not reveal. Set to 0 to
 * always rehydrate on reconnect. Independent of `resumeGraceMs`.
 *
 * `volatileBackpressureBytes` (default 4 MB) is the `WS.bufferedAmount`
 * threshold at which `.fireAndForget()` sends are dropped silently and
 * `__devtools.volatileDropped` increments. Sized for 120Hz cursor + drag
 * traffic; raise it if your app legitimately bursts above 4 MB of in-flight
 * volatile traffic, lower it on mobile-constrained targets where the OS
 * send buffer is tighter.
 *
 * `publishRateHint` (default enabled in dev) controls the one-shot console
 * hint logged when an inbound stream's frame rate crosses the high-frequency
 * threshold. Set `false` to silence it. Production builds strip the hint
 * regardless, so this only matters in development.
 *
 * `protocolVersion` is an opt-in integer the app bumps only on a BREAKING
 * wire/contract change, declared identically here and in `realtime({ protocolVersion })`
 * on the server (one shared constant). The client advertises it once on connect; a
 * server running a higher version replies with a one-shot `protocol-stale` notice,
 * which surfaces the `health` store as `'outdated'` and logs a dev console warning so
 * a long-lived client running a stale bundle after a breaking deploy knows to reload.
 * Omit it to leave the signal off.
 *
 * The `offline` object grows the durable-queue options: `persist` (true =
 * IndexedDB in a browser, in-memory elsewhere; or a custom store) makes
 * queued mutations survive a reload, `persistKey` scopes the persisted queue
 * (use an opaque account key so one browser profile never replays user A's mutations
 * as user B), and `conflictResolution` + `onConflict` decide what a REPLAYED
 * mutation does when the server rejects it with `LiveError('CONFLICT')`:
 * `'server-win'` (default) drops it, `'lww'` re-issues it once (the local
 * write wins by being applied last), `'custom'` asks `onConflict(call, error)`
 * - return an args array to re-issue once with merged args, anything else to
 * drop. The `'batch'` replay strategy is an alias of `'concurrent'`.
 *
 * @param {{ url?: string, auth?: boolean | string, onConnect?: () => void, onDisconnect?: () => void, timeout?: number, resumeGraceMs?: number, resumeMaxCursorAgeMs?: number, volatileBackpressureBytes?: number, publishRateHint?: boolean, protocolVersion?: number, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, retentionMs?: number, replay?: 'sequential' | 'concurrent' | 'batch' | ((queue: OfflineEntry[]) => Array<OfflineEntry | null>), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void, persist?: boolean | import('./offline-store.js').OfflineStore, persistKey?: string, conflictResolution?: 'lww' | 'server-win' | 'custom', onConflict?: (call: { path: string, args: any[], queuedAt: number }, error: any) => any } }} config
 */
export function configure(config) {
	const previousScope = _offlineScope();
	clientState.config = config;

	if (config.offline) {
		const cr = config.offline.conflictResolution;
		if (cr !== undefined && !_CONFLICT_RESOLUTIONS.has(cr)) {
			throw new Error("[svelte-realtime] configure({ offline.conflictResolution }): must be 'lww', 'server-win', or 'custom'");
		}
		if (config.offline.onConflict !== undefined && typeof config.offline.onConflict !== 'function') {
			throw new Error('[svelte-realtime] configure({ offline.onConflict }): must be a function');
		}
		if (cr === 'custom' && typeof config.offline.onConflict !== 'function') {
			throw new Error("[svelte-realtime] configure({ offline }): conflictResolution 'custom' requires an onConflict hook");
		}
		_configureOfflinePersistence(config.offline);
	}

	// Mirror the server's realtime({ protocolVersion }) integer validation so the
	// shared-constant contract is symmetric and a typo (null / float) cannot quietly
	// advertise a bad version that latches the client to a permanent 'outdated'.
	if (config.protocolVersion !== undefined && !Number.isInteger(config.protocolVersion)) {
		throw new Error('[svelte-realtime] configure({ protocolVersion }): must be an integer');
	}

	if (config.url !== undefined || config.auth !== undefined) {
		if (_closedForGoodNow()) {
			// A client whose connection closed for good stays closed; building a
			// connection here would only open a socket nothing listens on.
			if (_IS_DEV) {
				console.warn('[svelte-realtime] configure({ url, auth }) is ignored once the connection has closed for good; call the adapter connect() explicitly to connect again.');
			}
		} else {
			/** @type {{ url?: string, auth?: boolean | string }} */
			const connectArgs = {};
			if (config.url !== undefined) connectArgs.url = config.url;
			if (config.auth !== undefined) connectArgs.auth = config.auth;
			_connect(connectArgs);
		}
	}

	// Protocol-compat signal opt-in: ensure the __realtime listener is active so a
	// server `protocol-stale` notice is observed (health -> 'outdated' + dev warn)
	// even if the app never reads the `health` store directly. Idempotent. MUST run
	// AFTER the url/auth `_connect(connectArgs)` above: _ensureHealthSubscription
	// binds the connection, creating it if none exists yet, and whichever call
	// creates it fixes the endpoint - so creating the listener's connection before
	// the configured one would pin the default same-origin URL and make the
	// adapter ignore url/auth.
	if (config.protocolVersion !== undefined) _ensureHealthSubscription();

	if (!_configListenerAttached) {
		// Binding the connection attaches its own status listener first, so the
		// onDisconnect callback below already sees a close for good as terminated.
		const conn = _conn();
		_configListenerAttached = true;
		let isFirst = true;
		conn.status.subscribe((s) => {
			if (isFirst) { isFirst = false; return; }
			if (s === 'open') {
				clientState.isOffline = false;
				_callConnectionHook('onConnect');
				_drainOfflineQueue();
			}
			if (s === 'disconnected' || s === 'failed') {
				clientState.isOffline = true;
				_cancelRedrain();
				_callConnectionHook('onDisconnect');
			}
		});
	}
	if (previousScope !== _offlineScope() && (_replayingScope || previousScope.configuredStore)) void _drainOfflineQueue();
}

/** Call an app observer without interrupting the connection status store. */
function _callConnectionHook(name) {
	const hook = clientState.config[name];
	if (typeof hook !== 'function') return;
	const report = (err) => {
		if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
		else console.error('[svelte-realtime] ' + name + ' threw:', err);
	};
	try {
		const result = hook.call(clientState.config);
		if (result && typeof result.then === 'function') Promise.resolve(result).catch(report);
	} catch (err) {
		report(err);
	}
}

/**
 * Drain the offline queue on reconnection. Awaits the one-shot persistence
 * rehydrate first (a drain must never race the restore and replay a
 * half-loaded queue), holds the `uploading` backpressure signal while
 * replaying, settles each entry's durability (persisted copy dropped,
 * checkpoint advanced on success), and routes CONFLICT rejections through
 * the configured resolution instead of the plain error path. When the
 * connection goes away during the drain, it stops and puts what it has not
 * settled back in the queue for the next reconnect.
 */
async function _drainOfflineQueue() {
	const closedEpoch = clientState.closedEpoch;
	const closed = () => closedEpoch !== clientState.closedEpoch;
	const scope = _offlineScope();
	if (_replayingScope === scope) return;
	_replayingScope = scope;
	_startOfflineDrain(scope);
	let again = false, retryIdempotency = false, reachedQueue = false;
	// Calls an idempotency refusal holds the queue for: when each was refused,
	// when its wait ends, the soonest the server allows it again, and the
	// refusal; and when the last of the waits ends.
	/** @type {Map<OfflineEntry, { refusedAt: number, until: number, notBefore: number, err: any }>} */
	const held = new Map();
	let heldUntil = 0;
	// Whether the drain ran before the latest backoff ended, and the drain's
	// retention.
	let earlyDrain = false;
	let maxAge = 0;
	try {
		await _offlineReady();
		if (scope !== _offlineScope()) return;
		// Gone again while the restore was read, or the socket is being
		// replaced (a replay is sent only on an open socket): the next open
		// drains.
		if (closed() || clientState.isOffline || clientState.terminated || !clientState.socketUp) return;
		const readyAt = now();
		// Before the latest backoff ends only set-aside calls that are due and
		// would expire by then go up: the held head and the rest wait for it.
		const floorAt = _floorOf(scope);
		const early = earlyDrain = readyAt < floorAt;
		maxAge = clientState.config.offline?.maxAge || 0;
		const ready = (/** @type {OfflineEntry} */ entry, /** @type {number} */ at) => !_isHeldAfterClose(entry) && (early ? _urgent(entry, at, floorAt, maxAge) : !_waiting(entry, at));
		if (!_offlineQueue.some(entry => ready(entry, readyAt))) return;
		_setUploading(true);
		if (scope !== _offlineScope()) return;

		const offlineOpts = clientState.config.offline;
		const beforeReplay = offlineOpts?.beforeReplay;
		const onConflict = offlineOpts?.onConflict;
		const conflictResolution = offlineOpts?.conflictResolution || 'server-win';
		const nowMs = now();
		// Whether a call is past its retention at `at`.
		const expiredAt = (/** @type {OfflineEntry} */ entry, /** @type {number} */ at) => _expiredAt(entry, at, maxAge);

		// Whether the batch went up in order with nothing failing (a clean
		// drain closes the gap), and the lowest seq that failed in it: a
		// success above it leaves a hole in the upload order (gapDetected). A
		// drain that carries on one a lost connection or a closed page cut off
		// starts from where that one stopped.
		const batch = _batchState();
		let clean = batch.clean;
		let lowestFailedSeq = batch.failedSeq;
		// A call that goes up ahead of one still held back leaves a hole too.
		let heldBackSeq = Infinity;
		_beginBatch();
		if (scope !== _offlineScope()) return;
		// The connection went away during the drain: nothing more is sent.
		let cut = false;
		/** @type {Set<OfflineEntry>} */
		const settled = new Set();
		/** @type {Set<OfflineEntry>} Calls set aside until their retryAt; still queued. */
		const deferred = new Set();
		/**
		 * The path and args a replay function gave a call in place of its own.
		 * @type {Map<OfflineEntry, { path: string, args: any[] }>}
		 */
		const overrides = new Map();

		/** @param {OfflineEntry} entry @param {any} result */
		function settleOk(entry, result) {
			settled.add(entry);
			const hole = Math.min(lowestFailedSeq, heldBackSeq) < (entry.seq ?? 0);
			if (hole) clean = false;
			_settlePersist(entry, true, hole);
			entry.resolve(result);
		}

		/**
		 * Set a call aside: reported like a failure and counted as a hole in the
		 * upload order, but kept with its stored copy and pending caller.
		 * @param {OfflineEntry} entry @param {any} err @param {number} retryAt
		 */
		function defer(entry, err, retryAt) {
			if (scope !== _offlineScope()) return;
			deferred.add(entry);
			clean = false;
			lowestFailedSeq = Math.min(lowestFailedSeq, entry.seq ?? 0);
			if (typeof entry.seq === 'number') _noteBatchFailure(entry.seq);
			_setRetryAt(entry, retryAt);
			const over = overrides.get(entry);
			_notifyReplayError({ path: over ? over.path : entry.path, args: over ? over.args : entry.args, queuedAt: entry.queuedAt }, err);
		}

		/** @param {OfflineEntry} entry @param {any} err */
		function settleFail(entry, err) {
			if (scope !== _offlineScope()) return;
			settled.add(entry);
			clean = false;
			lowestFailedSeq = Math.min(lowestFailedSeq, entry.seq ?? 0);
			if (typeof entry.seq === 'number') _noteBatchFailure(entry.seq);
			_settlePersist(entry, false);
			if (scope !== _offlineScope()) return;
			const over = overrides.get(entry);
			_notifyReplayError({ path: over ? over.path : entry.path, args: over ? over.args : entry.args, queuedAt: entry.queuedAt }, err);
			entry.reject(err);
		}

		/**
		 * Replay one entry, applying the conflict stance: a CONFLICT rejection
		 * (the canonical app-thrown "server state moved under this write" code)
		 * resolves per policy - server-win drops, lww re-issues the same call
		 * once, custom asks onConflict for merged args (array = one re-issue,
		 * anything else = drop). One retry ever; a second CONFLICT drops.
		 * @param {OfflineEntry} entry
		 */
		async function replayOne(entry) {
			const over = overrides.get(entry);
			const path = over ? over.path : entry.path;
			let args = over ? over.args : entry.args;
			let retried = false;
			for (;;) {
				// Nothing is sent once the drain was cut, nor while the connection
				// is down: `_sendRpc` would queue the call again as a new entry, and
				// this drain would wait on that. Nor while the socket is being
				// replaced (app code run by the last settle can start that): a
				// replay is sent only on an open socket, and on the closing one it
				// would go nowhere and wait for its timeout.
				if (scope !== _offlineScope() || closed() || cut || clientState.isOffline || clientState.terminated || !clientState.socketUp) {
					cut = true;
					return;
				}
				try {
					const result = await _sendRpc(path, args, entry.idempotencyKey, entry.timeout, true);
					settleOk(entry, result);
					return;
				} catch (err) {
					if (scope !== _offlineScope()) return;
					// The connection went away under the replay (a drop, a device
					// sleep, the close for good) and it may never have reached the
					// server: not a replay failure.
					if (_isConnectionLoss(err)) {
						cut = true;
						return;
					}
					if (err && (err.code === 'IDEMPOTENCY_IN_PROGRESS' || err.code === 'IDEMPOTENCY_CAPACITY')) {
						// The server's hint says when the call can be admitted; without
						// one the call backs off. Holding the queue longer than the hold
						// in all would stall every call queued behind it.
						const hinted = typeof err.retryAfter === 'number';
						let wait;
						if (hinted) wait = Math.max(1000, err.retryAfter);
						else wait = entry.idempotencyBackoff = entry.idempotencyBackoff ? Math.min(entry.idempotencyBackoff * 2, _IDEMPOTENCY_BACKOFF_MAX_MS) : 1000;
						const refusedAt = now();
						// A server that names a time past the retention can only see
						// the call expire, and so does a refused last try.
						const serverLate = hinted && expiredAt(entry, refusedAt + err.retryAfter);
						if (serverLate || entry.idempotencyLastTry || expiredAt(entry, refusedAt)) {
							/** @type {any} */
							const stale = new RpcError('STALE', serverLate ? 'Offline mutation expired: the server asked to retry it after its retention ends' : 'Offline mutation expired');
							stale.cause = err;
							settleFail(entry, stale);
							return;
						}
						// The client's own wait (its backoff, or the one-second
						// minimum on a hint) is cut to one last try within it.
						if (expiredAt(entry, refusedAt + wait)) {
							entry.idempotencyLastTry = true;
							// Never before the server's hint, which fits (it is not late).
							wait = Math.max(hinted ? err.retryAfter : 0, _lastTryAt(entry, maxAge, refusedAt) - refusedAt);
						}
						// A call sent ahead of the held head is set aside again: a
						// hold would keep it until the head's backoff ends.
						if (early || wait > _IDEMPOTENCY_REPLAY_HOLD_MS || (entry.idempotencyHeld || 0) + wait > _IDEMPOTENCY_REPLAY_HOLD_MS) {
							entry.idempotencyHeld = 0;
							defer(entry, err, refusedAt + wait);
							return;
						}
						// The queue waits for the last of the waits of the calls it
						// holds, and for the rest of the drain.
						held.set(entry, { refusedAt, until: refusedAt + wait, notBefore: hinted ? refusedAt + err.retryAfter : refusedAt, err });
						heldUntil = Math.max(heldUntil, refusedAt + wait);
						cut = true;
						retryIdempotency = true;
						return;
					}
					if (err && err.code === 'CONFLICT' && !retried) {
						const call = { path, args, queuedAt: entry.queuedAt };
						if (conflictResolution === 'lww') {
							retried = true;
							continue;
						}
						if (conflictResolution === 'custom') {
							let merged;
							// Taken as JSON now: args that cannot be sent drop the call.
							try {
								merged = onConflict ? onConflict(call, err) : undefined;
								if (Array.isArray(merged)) merged = _jsonCopy(merged);
							} catch {
								merged = undefined;
							}
							if (Array.isArray(merged)) {
								retried = true;
								args = merged;
								continue;
							}
							settleFail(entry, err);
							return;
						}
						// server-win: the server state stands; notify and drop.
						if (onConflict) {
							try { onConflict(call, err); } catch { /* observer only */ }
						}
						settleFail(entry, err);
						return;
					}
					settleFail(entry, err);
					return;
				}
			}
		}

		// Filter the queue
		/** @type {OfflineEntry[]} */
		let queue = [];
		let asyncFilterWarned = false;
		let throwingFilterWarned = false;
		const expired = (/** @type {OfflineEntry} */ entry) => expiredAt(entry, nowMs);
		// A call set aside stays queued until it is due, unless it expired.
		reachedQueue = true;
		const captured = new Set(_offlineQueue.filter(entry => ready(entry, nowMs) || (!_isHeldAfterClose(entry) && expired(entry))));
		if (early) for (const entry of _offlineQueue) if (!captured.has(entry)) heldBackSeq = Math.min(heldBackSeq, entry.seq ?? 0);
		for (const entry of captured) {
			if (entry.settled) continue;
			if (scope !== _offlineScope()) return;
			if (expired(entry)) {
				settleFail(entry, new RpcError('STALE', 'Offline mutation expired'));
				continue;
			}
			if (beforeReplay) {
				let keep;
				/** @type {any} */
				let refused = null;
				try {
					keep = beforeReplay({ path: entry.path, args: entry.args, queuedAt: entry.queuedAt });
					// A promise is truthy, but it is no answer yet.
					if (keep !== null && typeof keep === 'object' && typeof keep.then === 'function') {
						Promise.resolve(keep).catch(() => {});
						refused = new RpcError('STALE', 'Offline mutation dropped: beforeReplay returned a promise');
						if (_IS_DEV && !asyncFilterWarned) {
							asyncFilterWarned = true;
							console.warn('[svelte-realtime] offline.beforeReplay returned a promise; it must answer synchronously, so the call is dropped as STALE.');
						}
					}
				} catch (err) {
					// The filter's own error counts as a refusal: the call is dropped
					// and reported, never sent past a guard that could not decide.
					// Holding it back instead would send it later, after calls
					// queued behind it and calls made since. A restored call has no
					// promise to report it, hence the warning.
					refused = new RpcError('STALE', 'Offline mutation dropped: beforeReplay threw');
					refused.cause = err;
					if (_IS_DEV && !throwingFilterWarned) {
						throwingFilterWarned = true;
						console.warn('[svelte-realtime] offline.beforeReplay threw, so the call is dropped as STALE, with the error as the cause of its rejection.' + _causeOf(err));
					}
				}
				if (refused) {
					settleFail(entry, refused);
					continue;
				}
				if (!keep) {
					settleFail(entry, new RpcError('STALE', 'Offline mutation dropped by beforeReplay filter'));
					continue;
				}
			}
			// Picked up: it is held back no longer, here and in its stored copy.
			if (entry.retryAt !== undefined) _setRetryAt(entry, undefined);
			queue.push(entry);
		}
		if (scope !== _offlineScope()) return;
		// Queued entries already belong to the live array. Track them separately
		// only while a drain takes ownership, avoiding a second enqueue index.
		queue = queue.filter(entry => !entry.settled);
		_ownOfflineReplay(scope, queue);
		let remaining = 0;
		for (const entry of _offlineQueue) if (!captured.has(entry)) _offlineQueue[remaining++] = entry;
		_offlineQueue.length = remaining;
		_bumpPending();
		if (scope !== _offlineScope()) return;

		// A custom replay function picks the calls to replay and their order.
		// It gets copies, so changing one changes no queued call (its seq or
		// idempotency key least of all). One it leaves out is dropped like a
		// beforeReplay drop; an answer that decides nothing (see
		// `_readReplayAnswer`) replays the queue as it is. The queue was emptied
		// above, so nothing here may throw.
		if (typeof offlineOpts?.replay === 'function') {
			/** @type {ReturnType<typeof _readReplayAnswer>} */
			let answer;
			/** @type {OfflineEntry[]} */
			const given = [];
			/** @type {OfflineEntry[]} */
			const sendable = [];
			for (const entry of queue) {
				let args;
				try {
					args = _jsonCopy(entry.args);
				} catch (error) {
					// Stored args that cannot be serialized (a custom store, or a call an
					// earlier version stored with a BigInt or a cycle in it) can never
					// be sent: the call is dropped before the function sees the rest.
					/** @type {any} */
					const stale = new RpcError('STALE', 'Offline mutation dropped: its stored args cannot be sent');
					stale.cause = error;
					settleFail(entry, stale);
					continue;
				}
				sendable.push(entry);
				given.push({ ...entry, args });
			}
			queue = sendable;
			try {
				const picked = offlineOpts.replay(given);
				try {
					answer = _readReplayAnswer(picked, queue);
				} catch {
					answer = 'returned an answer that could not be read';
				}
			} catch (err) {
				answer = 'threw' + _causeOf(err);
			}
			if (typeof answer === 'string') {
				if (_IS_DEV) console.warn('[svelte-realtime] offline.replay ' + answer + ', so the queue replays as it is.');
			} else {
				if (answer.foreign > 0 && _IS_DEV) {
					console.warn('[svelte-realtime] offline.replay returned ' + answer.foreign + ' item(s) that are not queued calls, so they are ignored. Return the entries it was given, or copies of them.');
				}
				for (const [entry, over] of answer.overrides) overrides.set(entry, over);
				const keptSet = new Set(answer.kept);
				for (const entry of queue) {
					if (keptSet.has(entry)) continue;
					const unsendable = answer.unsendable.get(entry);
					if (unsendable === undefined) {
						settleFail(entry, new RpcError('STALE', 'Offline mutation dropped by the replay function'));
					} else {
						/** @type {any} */
						const stale = new RpcError('STALE', 'Offline mutation dropped: the replay function gave it args that cannot be sent');
						stale.cause = unsendable.error;
						settleFail(entry, stale);
					}
				}
				queue = answer.kept;
			}
		}

		// Replay using the configured strategy
		const strategy = offlineOpts?.replay;
		if ((strategy === 'concurrent' || strategy === 'batch') && queue.length > 0) {
			// Concurrent strategy: send queued calls with concurrency limit to avoid flooding
			const concurrency = 10;
			for (let i = 0; i < queue.length; i += concurrency) {
				const chunk = queue.slice(i, i + concurrency);
				await Promise.all(chunk.map((entry) => replayOne(entry)));
			}
		} else {
			// Sequential strategy (default)
			for (const entry of queue) {
				await replayOne(entry);
			}
		}

		// A held call whose retention ends before the queue goes again is set
		// aside instead, so its own wake still gives it its try; one that has
		// expired already is dropped. Not when the connection went: the next
		// open replays the queue as it was, and a last try the loss kept from
		// going out is not used up.
		if (closed() || clientState.isOffline) for (const entry of held.keys()) delete entry.idempotencyLastTry;
		else if (held.size) {
			const redrainAt = Math.max(now(), heldUntil);
			heldUntil = 0;
			for (const [entry, hold] of held) {
				if (!expiredAt(entry, redrainAt)) {
					heldUntil = Math.max(heldUntil, hold.until);
					continue;
				}
				held.delete(entry);
				entry.idempotencyHeld = 0;
				if (expiredAt(entry, now())) {
					/** @type {any} */
					const stale = new RpcError('STALE', 'Offline mutation expired');
					stale.cause = hold.err;
					settleFail(entry, stale);
					continue;
				}
				let retryAt = hold.until;
				// Never before the server's hint, which fits (it is not late).
				const lastTry = Math.max(hold.notBefore, _lastTryAt(entry, maxAge, hold.refusedAt));
				if (retryAt > lastTry) {
					entry.idempotencyLastTry = true;
					retryAt = lastTry;
				}
				defer(entry, hold.err, retryAt);
			}
		}
		if (scope !== _offlineScope()) return;
		// A replay that was cut off may have been applied: the drain is not clean.
		if (closed()) cut = true;
		if (cut) clean = false;
		if (cut) {
			// What the drain did not settle goes back to the front of the queue
			// as it was queued (same seq, idempotency key and stored copy, call
			// still pending), in seq order and ahead of anything queued since, so
			// a custom `replay` function sees it as before at the next drain.
			const back = queue.filter((entry) => !settled.has(entry)).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
			// The next drain carries on this batch: a call queued after one that
			// failed here still leaves a hole when it goes up then.
			_carryBatch(lowestFailedSeq);
			if (scope !== _offlineScope()) return;
			_offlineQueue.unshift(...back);
			// After the close for good the queue is kept as it is for a later page
			// load: trimming it would delete stored copies the close keeps.
			const dropped = (closed() || clientState.terminated) ? [] : _trimQueue(_queueLimit(offlineOpts));
			if (closed() || clientState.terminated) {
				// Handled as the queue was at the close: kept with a stored copy,
				// rejected without one.
				for (const entry of back) _keepIfStored(entry, _connectionClosedError);
			} else if (!clientState.isOffline) {
				// Up again already (its reconnect found this drain still running),
				// or the drop was never reported, as after a device sleep.
				again = true;
			}
			_settleDropped(dropped);
		} else {
			// The batch went up in full. A clean one (no failure, no hole,
			// nothing left queued) closes any upload-order hole an EARLIER batch
			// left; one that failed or left a hole keeps the gap visible for the
			// app to act on. The next drain starts a new batch.
			if (clean && !early) _clearGapIfClean();
			if (scope !== _offlineScope()) return;
			// Calls set aside go back to the front of the queue, in seq order.
			if (deferred.size) _offlineQueue.unshift(...[...deferred].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)));
			// While any call is set aside the batch carries on: one going up after
			// calls queued behind it is an upload-order hole no drain may close.
			// So does a drain that left the held head waiting.
			if (early || _offlineQueue.some(entry => entry.retryAt !== undefined)) _carryBatch(lowestFailedSeq);
			else _endBatch();
		}
	} finally {
		// First, so nothing that runs app code below can leave every later
		// drain a no-op.
		_finishOfflineDrain(scope);
		if (_replayingScope !== scope) return;
		_replayingScope = null;
		_bumpPending();
		// Calls set aside: one that came due while this drain ran goes next, a
		// later one when it is due, and before the latest backoff ends only if
		// it would expire by then. A drain that returned before reading the
		// queue leaves due calls to the next open, so this never spins.
		const at = now();
		let floorAt = _floorOf(scope);
		let due = false;
		for (const entry of _offlineQueue) {
			if (entry.retryAt === undefined || entry.retryAt > at || _isHeldAfterClose(entry)) continue;
			if (at >= floorAt || _urgent(entry, at, floorAt, maxAge)) due = true;
		}
		// Draining again keeps `uploading` up: what was put back still waits to
		// go out, and that drain clears it when it ends.
		if (!retryIdempotency && (again || (due && reachedQueue && clientState.socketUp))) void _drainOfflineQueue();
		else {
			_setUploading(false);
			if (again && !clientState.isOffline && !clientState.terminated) {
				// The held calls wait out the last of their waits, or the rest of
				// the drain if that took longer, and count it toward the hold.
				const redrainAt = Math.max(at, heldUntil);
				_redrainNotBefore = { scope, at: Math.max(_floorOf(scope), redrainAt) };
				for (const [entry, hold] of held) entry.idempotencyHeld = (entry.idempotencyHeld || 0) + redrainAt - hold.refusedAt;
				_scheduleRedrain(redrainAt - at);
			}
		}
		// The wakes: the next set-aside call to come due, sooner for one that
		// would expire before the latest backoff ends, and that end itself.
		floorAt = _floorOf(scope);
		let wakeAt = Infinity, urgentAt = Infinity, waitsForFloor = false;
		for (const entry of _offlineQueue) {
			if (_isHeldAfterClose(entry)) continue;
			if (entry.retryAt !== undefined && _urgent(entry, entry.retryAt, floorAt, maxAge)) urgentAt = Math.min(urgentAt, entry.retryAt);
			else if (entry.retryAt !== undefined && entry.retryAt > at) wakeAt = Math.min(wakeAt, entry.retryAt);
			else waitsForFloor = true;
		}
		if (urgentAt !== Infinity && (urgentAt > at || reachedQueue)) _scheduleRedrain(Math.max(0, urgentAt - at), true);
		if (wakeAt !== Infinity) _scheduleRedrain(wakeAt - at);
		// A drain before the backoff ended may end after it, with no wake left
		// for the held head.
		if (waitsForFloor && (floorAt > at || earlyDrain)) _scheduleRedrain(Math.max(0, floorAt - at));
	}
}

/**
 * What a custom `replay` function answered, read as untrusted: the queued
 * calls it picked, in its order, and the path and args a copy replays a call
 * with in place of its own (never the call's idempotency key or stored copy).
 * A copy is matched to its call by `resolve`, unique per call; one without a
 * `resolve` function, as a JSON copy is, by its `seq` and `idempotencyKey`.
 * A call returned twice replays once, and a `null` item is a call left out
 * (`undefined` is not: it reads as a forgotten `return`, so it counts as an
 * item that is not a queued call). A copy's args are taken as the JSON the
 * wire would carry, here, so what is sent cannot change or fail to serialize
 * later; a copy whose args cannot be taken that way is in `unsendable`, its
 * call dropped. The answer decides nothing (a reason string is returned)
 * when it is a promise, not an array, or holds items but not a single queued
 * call, which reads as copies that lost what identifies them (or a map
 * callback without `return`), not as a choice to drop every call.
 * @param {any} picked
 * @param {OfflineEntry[]} queue
 * @returns {{ kept: OfflineEntry[], overrides: Map<OfflineEntry, { path: string, args: any[] }>, unsendable: Map<OfflineEntry, { error: unknown }>, foreign: number } | string}
 */
function _readReplayAnswer(picked, queue) {
	if (picked !== null && typeof picked === 'object' && typeof picked.then === 'function') {
		// Its rejection is not the drain's to report.
		Promise.resolve(picked).catch(() => {});
		return 'returned a promise; it must return the calls to replay synchronously';
	}
	if (!Array.isArray(picked)) return 'did not return an array of queued calls';
	const byResolve = new Map(queue.map((entry) => [entry.resolve, entry]));
	/** @type {Map<number, OfflineEntry>} */
	const bySeq = new Map();
	for (const entry of queue) if (typeof entry.seq === 'number' && entry.seq > 0) bySeq.set(entry.seq, entry);
	/** @type {OfflineEntry[]} */
	const kept = [];
	const keptSet = new Set();
	/** @type {Map<OfflineEntry, { path: string, args: any[] }>} */
	const overrides = new Map();
	/** @type {Map<OfflineEntry, { error: unknown }>} */
	const unsendable = new Map();
	let foreign = 0;
	let items = 0;
	const n = picked.length;
	for (let i = 0; i < n; i++) {
		const item = picked[i];
		if (item === null) continue;
		items++;
		let original;
		if (typeof item === 'object') {
			const resolve = item.resolve;
			if (typeof resolve === 'function') {
				original = byResolve.get(resolve);
			} else {
				const copied = bySeq.get(item.seq);
				if (copied && copied.idempotencyKey === item.idempotencyKey) original = copied;
			}
		}
		if (!original) {
			foreign++;
			continue;
		}
		// A sendable copy of a call wins over an unsendable one before it.
		if (keptSet.has(original)) continue;
		if (item !== original) {
			const path = item.path;
			const args = item.args;
			if (path !== original.path || args !== original.args) {
				let sendArgs = original.args;
				if (Array.isArray(args)) {
					try {
						sendArgs = _jsonCopy(args);
					} catch (error) {
						unsendable.set(original, { error });
						continue;
					}
				}
				overrides.set(original, { path: typeof path === 'string' ? path : original.path, args: sendArgs });
			}
		}
		keptSet.add(original);
		kept.push(original);
	}
	if (items > 0 && kept.length === 0 && unsendable.size === 0) return 'returned ' + items + ' item(s) and none of them is a queued call';
	return { kept, overrides, unsendable, foreign };
}

/**
 * A copy of call args in the form the wire carries them.
 * @param {any[]} args
 * @returns {any[]}
 */
function _jsonCopy(args) {
	return JSON.parse(JSON.stringify(args));
}

/**
 * The message of a thrown error for a dev warning, read without trusting it.
 * @param {unknown} err
 * @returns {string}
 */
function _causeOf(err) {
	try {
		return err instanceof Error ? ' Cause: ' + err.message : '';
	} catch {
		return '';
	}
}

/**
 * Combine multiple stores into a single derived store.
 * The combining function receives the current value of each source store
 * and returns the combined value. When any source updates, the function re-runs.
 *
 * @param {...any} args - Source stores followed by a combining function as the last argument
 * @returns {import('svelte/store').Readable<any>}
 */
export function combine(...args) {
	const fn = args.pop();
	const sources = args;

	if (typeof fn !== 'function') {
		throw new Error('combine() requires a combining function as the last argument\n  See: https://svti.me/client');
	}
	if (sources.length < 2) {
		throw new Error('combine() requires at least 2 source stores\n  See: https://svti.me/client');
	}

	const values = new Array(sources.length);
	let subCount = 0;
	/** @type {Set<(v: any) => void>} */
	const subscribers = new Set();
	/** @type {Array<() => void>} */
	let sourceUnsubs = [];
	let currentValue;

	function notify() {
		const next = fn(...values);
		if (next === currentValue) return;
		currentValue = next;
		for (const sub of subscribers) sub(currentValue);
	}

	function startSources() {
		let initializing = true;
		sourceUnsubs = sources.map((source, i) => {
			return source.subscribe((v) => {
				values[i] = v;
				if (!initializing) {
					notify();
				}
			});
		});
		initializing = false;
		// Compute once after all sources have emitted their initial values
		currentValue = fn(...values);
	}

	function stopSources() {
		for (const unsub of sourceUnsubs) unsub();
		sourceUnsubs = [];
	}

	return {
		subscribe(sub) {
			if (subCount++ === 0) {
				startSources();
			}
			subscribers.add(sub);
			sub(currentValue);

			return () => {
				subscribers.delete(sub);
				if (--subCount === 0) {
					stopSources();
				}
			};
		}
	};
}

/**
 * Register a handler for point-to-point signals.
 * Signals are sent by `ctx.signal(userId, event, data)` on the server.
 *
 * The userId must match the one used by `enableSignals()` on the server,
 * because the server publishes to `__signal:${userId}`.
 *
 * @param {string} userId - The current user's id (must match server-side enableSignals)
 * @param {(event: string, data: any) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onSignal(userId, callback) {
	// Support legacy call signature: onSignal(callback)
	if (typeof userId === 'function' && callback === undefined) {
		callback = /** @type {(event: string, data: any) => void} */ (/** @type {unknown} */ (userId));
		userId = '';
	}
	const topic = userId ? ('__signal:' + userId) : '__signal';
	const store = _conn().on(topic);
	return store.subscribe((envelope) => {
		if (!envelope) return;
		callback(envelope.event, envelope.data);
	});
}

// - onPush -------------------------------------------------------------------
//
// Multiplexes server-initiated request frames by event name. The adapter's
// onRequest takes a single (event, data) handler; we keep a Map<event, fn>
// and install one shared dispatcher on first registration so apps register
// multiple events without overwriting each other.

/** @type {Map<string, (data: any) => any | Promise<any>>} */
const _pushHandlers = new Map();
/** @type {(() => void) | null} */
let _pushDispatcherUnsub = null;

function _ensurePushDispatcher() {
	if (_pushDispatcherUnsub) return;
	_pushDispatcherUnsub = _conn().onRequest(async (event, data) => {
		const handler = _pushHandlers.get(event);
		if (!handler) {
			throw new Error("[svelte-realtime] no push handler registered for event '" + event + "'");
		}
		return await handler(data);
	});
}

/**
 * Register a handler for a server-initiated push event. The server calls
 * `live.push({ userId }, event, data)` and awaits a reply; this handler
 * receives the data and the value it returns (sync or async) becomes the
 * reply to the server. Throwing rejects the server-side promise.
 *
 * Multiple events register independently. Calling `onPush` again with the
 * same event name replaces the previous handler. The returned function
 * unregisters the handler if it is still the active one.
 *
 * Internally backed by the adapter's `onRequest`; the realtime client
 * multiplexes by event name so apps install one handler per event without
 * overwriting each other.
 *
 * @param {string} event
 * @param {(data: any) => any | Promise<any>} handler
 * @returns {() => void} Unsubscribe function.
 *
 * @example
 * ```js
 * import { onPush } from 'svelte-realtime/client';
 *
 * onPush('confirm-delete', async ({ itemId }) => {
 *   return { confirmed: confirm('Delete item ' + itemId + '?') };
 * });
 * ```
 */
export function onPush(event, handler) {
	if (typeof event !== 'string' || event.length === 0) {
		throw new Error('[svelte-realtime] onPush: event must be a non-empty string');
	}
	if (typeof handler !== 'function') {
		throw new Error('[svelte-realtime] onPush: handler must be a function');
	}
	_pushHandlers.set(event, handler);
	_ensurePushDispatcher();
	return () => {
		if (_pushHandlers.get(event) === handler) {
			_pushHandlers.delete(event);
			if (_pushHandlers.size === 0 && _pushDispatcherUnsub) {
				_pushDispatcherUnsub();
				_pushDispatcherUnsub = null;
			}
		}
	};
}

/**
 * Reset the push handler registry. Tests only.
 * @internal
 */
export function _resetPushHandlers() {
	_pushHandlers.clear();
	if (_pushDispatcherUnsub) {
		_pushDispatcherUnsub();
		_pushDispatcherUnsub = null;
	}
}
