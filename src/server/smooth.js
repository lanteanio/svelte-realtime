// @ts-check
import { live } from '../server.js';
import { wallEpoch, setTimer, clearTimer } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _getIdentityKey } from './identity.js';

// Seam: the shared topic-fn resolver (_callTopicFn) stays in server.js (used by
// several live.* families); smooth registration reaches it through this, set at
// init (mirrors installCrdt).
let _callTopicFn;
export function installSmooth(seams) {
	_callTopicFn = seams.callTopicFn;
}

// --- Smoothed entities: prediction-friendly authoritative state ---
//
// `live.smooth()` declares a topic of server-authoritative entities whose
// owners predict their own input client-side. The server is the only writer
// of entity state: clients send COMMANDS (id-stamped input samples over a
// lossy volatile send), a per-topic tick drains them in arrival order through
// the app's shared `apply(state, command, ctx)`, and every drained owner gets
// an acknowledgement carrying the id of its last applied command plus the
// authoritative state - the client's reconciliation basis. Broadcast updates
// ride a reserved wire topic so the binary codec engages by prefix; with echo
// suppression on (the default) an owner's own commanded updates are excluded
// from the broadcast - the acknowledgement IS the owner's copy. Motion from
// `onMissing` produces no acknowledgement and is never excluded: the owner
// learns about server-side movement from the broadcast like everyone else.
//
// The heavy machinery (the authority, the wire codec, the topic prefix) lives
// in the adapter and is loaded lazily on first use: registration stays
// synchronous and apps that never declare a smooth export never resolve the
// module. The loader is also the version gate - an adapter without the smooth
// plugin fails with an actionable error, not a resolution crash at boot.

/** @type {{ createSmoothAuthority: Function, createSmoothWireCodec: Function, SMOOTH_TOPIC_PREFIX: string } | null} */
let _smoothRuntime = null;
/** @type {Promise<any> | null} */
let _smoothRuntimePromise = null;

// The specifier is assembled at runtime and the import carries @vite-ignore:
// bundlers must not pre-resolve it (an app on an older adapter would fail its
// BUILD instead of getting the actionable runtime error below, and this
// module runs server-side where node resolves the subpath natively).
const _SMOOTH_PLUGIN_SPECIFIER = 'svelte-adapter-uws' + '/plugins/smooth';

function _loadSmoothRuntime() {
	if (_smoothRuntime) return Promise.resolve(_smoothRuntime);
	if (!_smoothRuntimePromise) {
		// Capture the promise locally: if `_setSmoothRuntime` swaps the runtime
		// while this import is in flight, the late settlement must not clobber
		// the injected module - both handlers check that this promise is still
		// the live one before touching shared state.
		const p = import(/* @vite-ignore */ _SMOOTH_PLUGIN_SPECIFIER).then(
			(mod) => {
				if (_smoothRuntimePromise !== p) {
					return _smoothRuntime !== null ? _smoothRuntime : mod;
				}
				_smoothRuntime = /** @type {any} */ (mod);
				return mod;
			},
			(err) => {
				if (_smoothRuntimePromise !== p) {
					if (_smoothRuntime !== null) return _smoothRuntime;
				} else {
					_smoothRuntimePromise = null;
				}
				throw _smoothLoadError(err);
			}
		);
		_smoothRuntimePromise = p;
	}
	return _smoothRuntimePromise;
}

/**
 * Classify a smooth-plugin import failure. Only a missing module means
 * version skew; any other failure (a syntax error inside the plugin, a
 * broken transitive import) must surface as itself, not masquerade as an
 * out-of-date adapter.
 * @param {any} err
 * @returns {LiveError}
 * @internal exported for tests
 */
export function _smoothLoadError(err) {
	if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) {
		return new LiveError(
			'INTERNAL',
			'live.smooth() requires svelte-adapter-uws 0.6.0-next.24 or newer (the smooth plugin is missing from the installed adapter)'
		);
	}
	return new LiveError(
		'INTERNAL',
		'live.smooth() failed to load the adapter smooth plugin: ' + (err && err.message ? err.message : String(err))
	);
}

/**
 * Test seam: inject a smooth runtime module (or null to restore the lazy
 * loader). Lets the orchestration be exercised against a scripted authority
 * without resolving the adapter subpath.
 * @param {any} mod
 */
export function _setSmoothRuntime(mod) {
	_smoothRuntime = mod;
	_smoothRuntimePromise = null;
}

/**
 * Per-topic smooth records: the authority, its codec, the owning platform,
 * and the demand-armed tick timer. Created on first sync/command for a
 * topic, deleted once the last entity leaves.
 * @type {Map<string, { name: string, wireTopic: string, authority: any, codec: any, platform: any, tickMs: number, noEcho: boolean, timer: any }>}
 */
export const _smoothTopics = new Map();

/**
 * Sockets whose close path has already run. The sync/command handlers await
 * (guard, runtime load, platform subscribe - the adapter subscribe is a
 * silent no-op success on a freed handle), so a socket can close mid-handler;
 * a resumed handler that ensured an entity for it would create a ghost no
 * future close can ever remove. The handlers re-check membership here after
 * their awaits, and the tick self-heals any entity that slipped through.
 * WeakSet: closed sockets stay collectable.
 */
export const _smoothClosedWs = new WeakSet();

/** Test seam: clear every smooth record and cancel pending ticks. */
export function _resetSmooth() {
	for (const rec of _smoothTopics.values()) {
		if (rec.timer !== null) clearTimer(rec.timer);
	}
	_smoothTopics.clear();
}

function _smoothRecord(name, cfg, platform, rt) {
	let rec = _smoothTopics.get(name);
	if (rec === undefined) {
		rec = {
			name,
			wireTopic: rt.SMOOTH_TOPIC_PREFIX + name,
			authority: rt.createSmoothAuthority({
				apply: cfg.apply,
				onMissing: cfg.onMissing,
				queueCap: cfg.queueCap
			}),
			codec: rt.createSmoothWireCodec(),
			platform,
			tickMs: cfg.tickMs,
			noEcho: cfg.noEcho,
			timer: null
		};
		_smoothTopics.set(name, rec);
	}
	// The record follows the caller's live platform: dev-server restarts and
	// multi-platform test processes otherwise publish into a dead instance.
	rec.platform = platform;
	return rec;
}

function _smoothResolveInitial(cfg, key) {
	return typeof cfg.initial === 'function' ? cfg.initial(key) : cfg.initial;
}

function _smoothPublish(rec, event, data, excludeWs) {
	const platform = rec.platform;
	if (rec.codec && typeof platform.publishWire === 'function') {
		platform.publishWire(rec.wireTopic, event, data, rec.codec, excludeWs !== undefined ? { excludeWs } : undefined);
	} else {
		// Older platform: no per-subscriber walk, so no exclusion - the
		// echoed frame is harmless because owners skip their own key.
		platform.publish(rec.wireTopic, event, data, { compress: false });
	}
}

function _smoothSendTo(rec, ws, event, data) {
	const platform = rec.platform;
	if (rec.codec && typeof platform.sendWire === 'function') {
		platform.sendWire(ws, rec.wireTopic, event, data, rec.codec);
	} else if (typeof platform.send === 'function') {
		platform.send(ws, rec.wireTopic, event, data, { compress: false });
	}
}

function _armSmoothTick(rec) {
	if (rec.timer !== null) return;
	rec.timer = setTimer(() => {
		rec.timer = null;
		_smoothTick(rec);
	}, rec.tickMs);
}

function _smoothTick(rec) {
	// Drain first, publish after: `apply` is pure state -> state, so nothing
	// can publish mid-drain, and subscribers observe each tick atomically -
	// every update and acknowledgement below reflects the same drained state.
	const { updates, acks, idle } = rec.authority.drain();
	const t = wallEpoch();
	for (let i = 0; i < updates.length; i++) {
		const u = updates[i];
		// Echo suppression applies only to commanded updates: those owners get
		// their copy through the acknowledgement. onMissing-driven motion
		// produces no ack, so its owner must receive the broadcast or it
		// renders a frozen entity everyone else sees gliding.
		_smoothPublish(rec, 'update', { key: u.key, data: u.state }, rec.noEcho && u.commanded ? u.ws : undefined);
	}
	for (let i = 0; i < acks.length; i++) {
		const a = acks[i];
		// Self-heal: an entity whose socket closed between enqueue and drain
		// is a ghost - remove it and broadcast its departure instead of
		// acknowledging into a freed handle.
		if (a.ws && _smoothClosedWs.has(a.ws)) {
			const removed = rec.authority.removeWs(a.ws);
			for (let j = 0; j < removed.length; j++) {
				_smoothPublish(rec, 'remove', { key: removed[j] }, undefined);
			}
			continue;
		}
		_smoothSendTo(rec, a.ws, 'ack', { id: a.id, state: a.state, t });
	}
	if (rec.authority.size === 0) {
		_smoothTopics.delete(rec.name);
		return;
	}
	if (!idle) _armSmoothTick(rec);
}

/**
 * Close-path drain: remove every smooth entity owned by a closing socket,
 * broadcast its departure, and drop topic records that emptied out.
 * @param {any} ws
 */
export function _drainSmoothOnClose(ws) {
	if (_smoothTopics.size === 0) return;
	for (const [name, rec] of _smoothTopics) {
		const removed = rec.authority.removeWs(ws);
		for (let i = 0; i < removed.length; i++) {
			_smoothPublish(rec, 'remove', { key: removed[i] }, undefined);
		}
		if (rec.authority.size === 0) {
			if (rec.timer !== null) clearTimer(rec.timer);
			_smoothTopics.delete(name);
		}
	}
}

/**
 * Declare a topic of smoothed (predicted / reconciled) entities.
 *
 * The app writes ONE pure `apply(state, command, ctx)` in a plain shared
 * module, imports it here for the authoritative step, and imports the same
 * module in the component for client-side prediction - the two sides can
 * never drift because there is only one copy. Each connected identity owns
 * exactly one entity per topic, keyed like presence rosters; a client can
 * only ever send commands, never state.
 *
 * ```js
 * // $live/board.js
 * import { live } from 'svelte-realtime';
 * import { apply } from './board.shared.js';
 *
 * export const shape = live.smooth({
 *   topic: (ctx, boardId) => `shape:${boardId}`,
 *   apply,
 *   initial: { x: 0, y: 0 }
 * });
 * ```
 *
 * Options: `topic` (string or `(ctx, ...args) => string`), `apply` (the
 * shared step), `initial` (starting state, or `(key) => state`), `guard?`
 * (auth check, same shape as room guards), `onMissing?` (per-tick
 * continuation for command-less entities; omitted = hold position),
 * `tickMs?` (authoritative tick interval, default 50), `noEcho?` (suppress
 * echoing an owner's own commanded updates in broadcasts, default true - the
 * acknowledgement carries the owner's copy; onMissing motion has no
 * acknowledgement and always broadcasts to the owner too), `queueCap?`
 * (per-entity command queue bound), `topicArgs?` (explicit room-arg count
 * when the topic function's arity cannot express it).
 *
 * @param {{ topic: string | Function, apply: Function, initial: any, guard?: Function, onMissing?: Function, tickMs?: number, noEcho?: boolean, queueCap?: number, topicArgs?: number }} config
 */
export const _smoothRegister = function smooth(config) {
	if (!config || typeof config !== 'object') {
		throw new Error('[svelte-realtime] live.smooth() requires a config object\n  See: https://svti.me/smooth');
	}
	const topicFn = config.topic;
	if (typeof topicFn !== 'function' && typeof topicFn !== 'string') {
		throw new Error('[svelte-realtime] live.smooth() requires a topic (string or (ctx, ...args) => string)\n  See: https://svti.me/smooth');
	}
	if (typeof config.apply !== 'function') {
		throw new Error('[svelte-realtime] live.smooth() requires an apply(state, command, ctx) function - the shared simulation step\n  See: https://svti.me/smooth');
	}
	if (config.initial === undefined) {
		throw new Error('[svelte-realtime] live.smooth() requires an initial state (a value, or (key) => state)\n  See: https://svti.me/smooth');
	}
	if (config.onMissing !== undefined && typeof config.onMissing !== 'function') {
		throw new Error('[svelte-realtime] live.smooth() onMissing must be a function (state, lastCommand) => state');
	}
	const tickMs = config.tickMs === undefined ? 50 : config.tickMs;
	if (!(typeof tickMs === 'number' && Number.isFinite(tickMs) && tickMs > 0)) {
		throw new Error('[svelte-realtime] live.smooth() tickMs must be a positive number');
	}
	if (config.queueCap !== undefined && !(typeof config.queueCap === 'number' && Number.isInteger(config.queueCap) && config.queueCap >= 1)) {
		throw new Error('[svelte-realtime] live.smooth() queueCap must be an integer of at least 1');
	}
	const cfg = {
		apply: config.apply,
		initial: config.initial,
		onMissing: config.onMissing,
		queueCap: config.queueCap,
		tickMs,
		noEcho: config.noEcho !== false
	};
	const guard = config.guard;
	const argCount = config.topicArgs !== undefined
		? config.topicArgs
		: (typeof topicFn === 'function' ? Math.max(0, topicFn.length - 1) : 0);

	const resolveName = (ctx, roomArgs) =>
		typeof topicFn === 'function' ? _callTopicFn(topicFn, ctx, roomArgs) : topicFn;

	const smoothExport = /** @type {any} */ ({});
	smoothExport.__isSmooth = true;

	smoothExport.__smoothSync = live(async (ctx, ...args) => {
		const roomArgs = args.slice(0, argCount);
		if (guard) await guard(ctx, ...roomArgs);
		const name = resolveName(ctx, roomArgs);
		const rt = await _loadSmoothRuntime();
		const rec = _smoothRecord(name, cfg, ctx.platform, rt);
		// Walk-visible membership for the reserved wire topic: the platform
		// subscribe updates the adapter's per-connection subscription state,
		// which is what the broadcast walk delivers by. Reserved-prefix
		// topics never ride the client's own subscribe frames.
		if (ctx.ws && ctx.platform && typeof ctx.platform.subscribe === 'function') {
			const denial = await ctx.platform.subscribe(ctx.ws, rec.wireTopic);
			if (denial) {
				throw new LiveError(
					denial === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'FORBIDDEN',
					'smooth topic subscribe denied: ' + denial
				);
			}
		} else if (ctx.ws && typeof ctx.ws.subscribe === 'function') {
			try {
				ctx.ws.subscribe(rec.wireTopic);
			} catch {}
		}
		// Liveness re-check after the awaits above: if the socket closed while
		// the guard / runtime load / subscribe was pending, the close drain has
		// already run, and ensuring now would create a ghost entity bound to a
		// freed handle (or steal ownership from a live tab).
		if (ctx.ws && _smoothClosedWs.has(ctx.ws)) {
			if (rec.authority.size === 0 && rec.timer === null) _smoothTopics.delete(name);
			throw new LiveError('CONNECTION_CLOSED', 'WebSocket closed during smooth sync');
		}
		const key = _getIdentityKey(ctx);
		const ensured = rec.authority.ensure(key, ctx.ws, _smoothResolveInitial(cfg, key));
		return {
			topic: name,
			t: wallEpoch(),
			you: key,
			ack: ensured.lastAckedId,
			states: rec.authority.catalog()
		};
	});

	smoothExport.__smoothCommand = live.volatile(async (ctx, ...args) => {
		const roomArgs = args.slice(0, argCount);
		if (guard) await guard(ctx, ...roomArgs);
		const batch = args[argCount];
		if (!Array.isArray(batch) || batch.length === 0) return;
		const name = resolveName(ctx, roomArgs);
		const rt = await _loadSmoothRuntime();
		// Liveness re-check after the awaits: a command from a socket whose
		// close drain already ran must not re-create its entity. Volatile
		// path, so bail silently - there is no reply to error.
		if (ctx.ws && _smoothClosedWs.has(ctx.ws)) return;
		const rec = _smoothRecord(name, cfg, ctx.platform, rt);
		const key = _getIdentityKey(ctx);
		const existing = rec.authority.get(key);
		if (existing === undefined) {
			rec.authority.ensure(key, ctx.ws, _smoothResolveInitial(cfg, key));
		} else if (ctx.ws && existing.ws !== ctx.ws) {
			// One entity, one owning socket: the socket that last synced owns
			// the command stream. A second tab takes over by syncing, never
			// by racing commands.
			return;
		}
		if (rec.authority.enqueue(key, batch)) _armSmoothTick(rec);
	});

	return smoothExport;
};
