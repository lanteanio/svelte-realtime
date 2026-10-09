// @ts-check
import { connect as _connect } from 'svelte-adapter-uws/client';
import { now } from '../client-runtime.js';
import { clientState, RpcError, _offlineQueue, _IS_DEV, _isConnectionLoss } from './internal-state.js';
import { _sendRpc } from './rpc.js';
import { _conn, _closedForGoodNow, _connectionClosedError } from './connection.js';
import { _ensureHealthSubscription } from './health.js';
import { _configureOfflinePersistence, _offlineReady, _keepIfStored, _settlePersist, _bumpPending, _setUploading, _clearGapIfClean, _trimQueue, _batchState, _carryBatch, _endBatch, _queueLimit, _notifyReplayError, _settleDropped } from './offline.js';

/**
 * @typedef {{ path: string, args: any[], queuedAt: number, resolve: Function, reject: Function, idempotencyKey?: string, timeout?: number, seq?: number, restored?: boolean }} OfflineEntry
 */

const _CONFLICT_RESOLUTIONS = new Set(['lww', 'server-win', 'custom']);

/** @type {boolean} */
let _configListenerAttached = false;

/** @type {boolean} */
let _replayingQueue = false;

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
 * (pass your user id so one browser profile never replays user A's mutations
 * as user B), and `conflictResolution` + `onConflict` decide what a REPLAYED
 * mutation does when the server rejects it with `LiveError('CONFLICT')`:
 * `'server-win'` (default) drops it, `'lww'` re-issues it once (the local
 * write wins by being applied last), `'custom'` asks `onConflict(call, error)`
 * - return an args array to re-issue once with merged args, anything else to
 * drop. The `'batch'` replay strategy is an alias of `'concurrent'`.
 *
 * @param {{ url?: string, auth?: boolean | string, onConnect?: () => void, onDisconnect?: () => void, timeout?: number, resumeGraceMs?: number, resumeMaxCursorAgeMs?: number, volatileBackpressureBytes?: number, publishRateHint?: boolean, protocolVersion?: number, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, replay?: 'sequential' | 'concurrent' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void, persist?: boolean | import('./offline-store.js').OfflineStore, persistKey?: string, conflictResolution?: 'lww' | 'server-win' | 'custom', onConflict?: (call: { path: string, args: any[], queuedAt: number }, error: any) => any } }} config
 */
export function configure(config) {
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
				console.warn('[svelte-realtime] configure({ url, auth }) is ignored once the connection has closed for good; reload the page to connect again.');
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
			// The adapter reports a socket that opens while document.hidden as
			// `suspended`, then continues its onopen path synchronously. Advertise at
			// both connection-ready states so hello/resubscribe/queued work can never
			// outrun strict protocol admission. App reconnect work remains open-only.
			if ((s === 'open' || s === 'suspended') && clientState.config.protocolVersion !== undefined) {
				try { _conn().sendQueued({ type: 'proto', v: clientState.config.protocolVersion }); } catch { /* no connection handle yet */ }
			}
			if (s === 'open') {
				clientState.isOffline = false;
				if (clientState.config.onConnect) clientState.config.onConnect();
				_drainOfflineQueue();
			}
			if (s === 'disconnected' || s === 'failed') {
				clientState.isOffline = true;
				if (clientState.config.onDisconnect) clientState.config.onDisconnect();
			}
		});
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
	if (_replayingQueue) return;
	_replayingQueue = true;
	let again = false;
	try {
		await _offlineReady();
		// Gone again while the restore was read, or the socket is being
		// replaced (a replay is sent only on an open socket): the next open
		// drains.
		if (clientState.isOffline || clientState.terminated || !clientState.socketUp) return;
		if (_offlineQueue.length === 0) return;
		_setUploading(true);

		const offlineOpts = clientState.config.offline;
		const beforeReplay = offlineOpts?.beforeReplay;
		const onConflict = offlineOpts?.onConflict;
		const conflictResolution = offlineOpts?.conflictResolution || 'server-win';
		const maxAge = offlineOpts?.maxAge || 0;
		const nowMs = now();

		// Whether the batch went up in order with nothing failing (a clean
		// drain closes the gap), and the lowest seq that failed in it: a
		// success above it leaves a hole in the upload order (gapDetected). A
		// drain that carries on one the connection cut off starts from where
		// that one stopped.
		const batch = _batchState();
		let clean = batch.clean;
		let lowestFailedSeq = batch.failedSeq;
		// The connection went away during the drain: nothing more is sent.
		let cut = false;
		/** @type {Set<OfflineEntry>} */
		const settled = new Set();
		/**
		 * The path and args a replay function gave a call in place of its own.
		 * @type {Map<OfflineEntry, { path: string, args: any[] }>}
		 */
		const overrides = new Map();

		/** @param {OfflineEntry} entry @param {any} result */
		function settleOk(entry, result) {
			settled.add(entry);
			const hole = lowestFailedSeq < (entry.seq ?? 0);
			if (hole) clean = false;
			_settlePersist(entry, true, hole);
			entry.resolve(result);
		}

		/** @param {OfflineEntry} entry @param {any} err */
		function settleFail(entry, err) {
			settled.add(entry);
			clean = false;
			lowestFailedSeq = Math.min(lowestFailedSeq, entry.seq ?? 0);
			_settlePersist(entry, false);
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
				if (cut || clientState.isOffline || clientState.terminated || !clientState.socketUp) {
					cut = true;
					return;
				}
				try {
					const result = await _sendRpc(path, args, entry.idempotencyKey, entry.timeout, true);
					settleOk(entry, result);
					return;
				} catch (err) {
					// The connection went away under the replay (a drop, a device
					// sleep, the close for good) and it may never have reached the
					// server: not a replay failure.
					if (_isConnectionLoss(err)) {
						cut = true;
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
		for (const entry of _offlineQueue) {
			if (maxAge > 0 && nowMs - entry.queuedAt > maxAge) {
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
			queue.push(entry);
		}
		_offlineQueue.length = 0;
		_bumpPending();

		// A custom replay function picks the calls to replay and their order.
		// It gets copies, so changing one changes no queued call (its seq or
		// idempotency key least of all). One it leaves out is dropped like a
		// beforeReplay drop; an answer that decides nothing (see
		// `_readReplayAnswer`) replays the queue as it is. The queue was emptied
		// above, so nothing here may throw.
		if (typeof offlineOpts?.replay === 'function') {
			/** @type {ReturnType<typeof _readReplayAnswer>} */
			let answer;
			try {
				const picked = offlineOpts.replay(queue.map((entry) => ({ ...entry, args: _jsonCopy(entry.args) })));
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
					if (!keptSet.has(entry)) settleFail(entry, new RpcError('STALE', 'Offline mutation dropped by the replay function'));
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

		// A replay that was cut off may have been applied: the drain is not clean.
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
			_offlineQueue.unshift(...back);
			// After the close for good the queue is kept as it is for a later page
			// load: trimming it would delete stored copies the close keeps.
			const dropped = clientState.terminated ? [] : _trimQueue(_queueLimit(offlineOpts));
			if (clientState.terminated) {
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
			if (clean) _clearGapIfClean();
			_endBatch();
		}
	} finally {
		// First, so nothing that runs app code below can leave every later
		// drain a no-op.
		_replayingQueue = false;
		_bumpPending();
		// Draining again keeps `uploading` up: what was put back still waits to
		// go out, and that drain clears it when it ends.
		if (again) void _drainOfflineQueue();
		else _setUploading(false);
	}
}

/**
 * What a custom `replay` function answered, read as untrusted: the queued
 * calls it picked, in its order, and the path and args a copy replays a call
 * with in place of its own (never the call's idempotency key or stored copy).
 * A copy is matched to its call by `resolve`, unique per call; one without a
 * `resolve` function, as a JSON copy is, by its `seq` and `idempotencyKey`.
 * A call returned twice replays once, and a `null` or `undefined` item is a
 * call left out. A copy's args are taken as the JSON the wire would carry,
 * here, so what is sent cannot change or fail to serialize later. The answer
 * decides nothing (a reason string is returned) when it is a promise, not an
 * array, or holds items but not a single queued call, which reads as copies
 * that lost what identifies them, not as a choice to drop every call.
 * @param {any} picked
 * @param {OfflineEntry[]} queue
 * @returns {{ kept: OfflineEntry[], overrides: Map<OfflineEntry, { path: string, args: any[] }>, foreign: number } | string}
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
	let foreign = 0;
	let items = 0;
	const n = picked.length;
	for (let i = 0; i < n; i++) {
		const item = picked[i];
		if (item === null || item === undefined) continue;
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
		if (keptSet.has(original)) continue;
		keptSet.add(original);
		kept.push(original);
		if (item !== original) {
			const path = item.path;
			const args = item.args;
			if (path !== original.path || args !== original.args) {
				overrides.set(original, {
					path: typeof path === 'string' ? path : original.path,
					args: Array.isArray(args) ? _jsonCopy(args) : original.args
				});
			}
		}
	}
	if (items > 0 && kept.length === 0) return 'returned ' + items + ' item(s) and none of them is a queued call';
	return { kept, overrides, foreign };
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
