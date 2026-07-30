// @ts-check
import { live } from '../server.js';
import { wallEpoch, setTimer, clearTimer } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _getIdentityKey } from './identity.js';
import { _tenantTopic } from './tenant.js';
import { createInterestState, targetDelayMs } from './interest.js';
import { createLagComp, rayCircleHit, rayAabbHit } from './lagcomp.js';
import { createRttTracker } from './rtt.js';
import { createMonotonicClock } from './monoclock.js';
import { _executeVolatileRpc } from './dispatch.js';
import { _IS_DEV } from './env.js';

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

// The specifier actually imported. Equals the canonical constant in production;
// a test repoints it (see _setSmoothSpecifierForTest) to exercise the load-failure
// path against a real, rejecting resolution.
let _smoothSpecifier = _SMOOTH_PLUGIN_SPECIFIER;

// Whether the client->server binary command ingress route has been registered
// with the adapter (once per process). The route is global (keyed by the smooth
// command kind on the adapter's global ingress registry), so one registration
// serves every smooth topic; the per-topic destination rides each client's
// `ingress-bind`. Registered when the runtime resolves - and the runtime load is
// warmed eagerly at declaration (see the export builder) so the route is armed
// before any client binds.
let _ingressRouteRegistered = false;

/**
 * Register the smooth command ingress route with the adapter, if the loaded
 * runtime exposes the ingress surface (an adapter older than the ingress
 * feature simply lacks it, and the client then stays on the JSON command path -
 * no ack, no binary, no loss). Decode turns a `0x03` payload back into the
 * `Array<{id,cmd}>` batch; route replays it through the SAME volatile-RPC
 * executor the JSON path uses, so guards, `wire.command.unpack`, ownership,
 * cross-node relay, and `authority.enqueue(key, batch)` all run identically.
 * @param {any} rt - the loaded adapter smooth plugin module
 */
function _registerSmoothIngress(rt) {
	if (_ingressRouteRegistered || !rt) return;
	if (typeof rt.registerIngress !== 'function' ||
		typeof rt.decodeSmoothCommandBatch !== 'function' ||
		typeof rt.SMOOTH_COMMAND_CAPABILITY !== 'string') return;
	_ingressRouteRegistered = true;
	rt.registerIngress(rt.SMOOTH_COMMAND_CAPABILITY, {
		decode: (payload, schemaVersion) => rt.decodeSmoothCommandBatch(payload, schemaVersion),
		route: (ws, target, batch, platform) => {
			// target = { path: '<module>/<name>/__smooth/command', room: [...roomArgs] }.
			if (!ws || !target || typeof target.path !== 'string') return;
			const room = Array.isArray(target.room) ? target.room : [];
			_executeVolatileRpc(ws, { rpc: target.path, args: [...room, batch] }, platform);
		}
	});
}

function _loadSmoothRuntime() {
	if (_smoothRuntime) return Promise.resolve(_smoothRuntime);
	if (!_smoothRuntimePromise) {
		// Capture the promise locally: if `_setSmoothRuntime` swaps the runtime
		// while this import is in flight, the late settlement must not clobber
		// the injected module - both handlers check that this promise is still
		// the live one before touching shared state.
		const p = import(/* @vite-ignore */ _smoothSpecifier).then(
			(mod) => {
				if (_smoothRuntimePromise !== p) {
					return _smoothRuntime !== null ? _smoothRuntime : mod;
				}
				_smoothRuntime = /** @type {any} */ (mod);
				_registerSmoothIngress(_smoothRuntime);
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
	_registerSmoothIngress(mod);
}

/**
 * Test seam: repoint the lazily-imported plugin specifier (or pass null to
 * restore the default). Lets the load-failure path be exercised against a real
 * rejecting resolution without depending on the installed adapter version.
 * @param {string | null} spec
 * @internal
 */
export function _setSmoothSpecifierForTest(spec) {
	_smoothSpecifier = spec == null ? _SMOOTH_PLUGIN_SPECIFIER : spec;
	_smoothRuntime = null;
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

/**
 * Per-connection lag-compensation latency state, keyed by socket. Holds the
 * server-anchored round-trip tracker (how far back this connection may rewind)
 * and `lastRt` (the last accepted render-time, for replay rejection). Latency is
 * a property of the connection, not the topic, so it lives here rather than on a
 * topic record. WeakMap: state is dropped when the socket is collected, no manual
 * teardown. `{ tracker, lastRt }`.
 * @type {WeakMap<object, { tracker: ReturnType<typeof createRttTracker>, lastRt: number }>}
 */
const _lcRtt = new WeakMap();

/**
 * Window over which re-syncs are counted (see `_SMOOTH_SYNC_MAX_PER_WINDOW`).
 * The sync reply's roster costs O(catalog) to build AND serialize, and the RPC
 * has no transport-level rate limit, so an unthrottled stream of ~60-byte sync
 * frames is a large work-per-byte asymmetry against a populated topic.
 */
const _SMOOTH_RESYNC_WINDOW_MS = 1000;

/**
 * Hard ceiling on re-syncs per IDENTITY per window. Past this many syncs in one
 * window the RPC is refused instead of answered.
 *
 * Sized for legitimate bursts, not for steady state: a client syncs on join and
 * on reconnect, so several in a second is a flapping network (fine), while a
 * sustained stream is a flood (refused).
 *
 * SCOPE, stated honestly: the key is `_getIdentityKey`, so an AUTHENTICATED user
 * shares one allowance across all their sockets and tabs - a real global cap for
 * that user. An ANONYMOUS connection gets a per-socket guest key, so this bounds
 * a socket, not an attacker: N sockets buy N allowances. It removes the trivial
 * single-socket flood and raises the cost of the rest; it is not a substitute for
 * `live.rateLimit` or a connection cap on an app that allows anonymous smooth
 * topics. The work-per-byte asymmetry itself is inherent to answering a re-sync.
 */
const _SMOOTH_SYNC_MAX_PER_WINDOW = 5;

/**
 * The reserved wire-topic prefix (`__smooth:`), captured from the loaded
 * runtime so the cluster relay handlers - which receive the wire topic, not the
 * bare name - can resolve a record back through `_smoothTopics` by stripping it.
 * Resolving through the single topics map (rather than a second index) keeps the
 * relay path correct across HMR, which clears and rebuilds `_smoothTopics`.
 * @type {string | null}
 */
let _smoothPrefix = null;

/** Resolve the live record for a reserved wire topic, or undefined. */
function _smoothRecByWire(wireTopic) {
	if (_smoothPrefix !== null && wireTopic.startsWith(_smoothPrefix)) {
		return _smoothTopics.get(wireTopic.slice(_smoothPrefix.length));
	}
	return undefined;
}

/**
 * The reserved cell-topic prefix (`__smoothcell:`), captured beside
 * `_smoothPrefix` so the cluster relay handler can resolve an inbound CELL
 * frame back to its record. Cell topics are `<prefix><name>#<cellKey>`.
 * @type {string | null}
 */
let _smoothCellPrefix = null;

/**
 * Resolve a relayed cell wire topic to its live record and cell key, or null.
 * The cell key follows the LAST '#' (a cell key is `<cx>,<cy>` or `all`, never
 * containing '#', while a topic name may).
 */
function _smoothCellRecByWire(wireTopic) {
	if (_smoothCellPrefix === null || !wireTopic.startsWith(_smoothCellPrefix)) return null;
	const rest = wireTopic.slice(_smoothCellPrefix.length);
	const hash = rest.lastIndexOf('#');
	if (hash <= 0) return null;
	const rec = _smoothTopics.get(rest.slice(0, hash));
	if (rec === undefined || rec.cells === null) return null;
	return { rec, cellKey: rest.slice(hash + 1) };
}

/**
 * Cluster coordinators (`platform.smooth`) whose inbound relay handlers have
 * been wired. One registration per coordinator for the process lifetime: the
 * handlers dispatch by wireTopic to the live record. WeakSet so a replaced
 * coordinator is collectable.
 */
const _smoothClustersWired = new WeakSet();

/** Monotonic correlation-id source for cluster sync requests (unique per instance). */
let _smoothCorrSeq = 0;

/** How long a non-owner waits for the owner's sync reply before degrading to a local-empty basis. */
const _SMOOTH_SYNC_TIMEOUT_MS = 2000;

/**
 * How often the owner refreshes its ownership lease from the tick. Comfortably
 * inside the coordinator's default 10s lease TTL so a renew survives a GC pause
 * plus a Redis blip; an app on a shorter lease should keep its tick active.
 */
const _SMOOTH_RENEW_MS = 3000;

/**
 * Default debounce for the owner's warm-handoff snapshot write (ms). At most
 * this much entity state is lost on an owner crash; one Redis write per topic
 * per interval while the topic is owned and non-empty. Overridable per topic
 * via `snapshotDebounceMs`.
 */
const _SMOOTH_SNAPSHOT_MS = 1000;

/**
 * How long a recovered-but-not-yet-rebound entity state is held (and re-persisted)
 * after a warm-handoff acquire. Past this window a still-absent client is treated
 * as departed: its pending state is dropped so the cache stays bounded and the
 * snapshot tracks the live roster.
 */
const _SMOOTH_PENDING_GRACE_MS = 30000;

/**
 * The outbound-queue window that scales a subscriber's `interest.budget` down.
 * Below LOW (the adapter pressure sampler's "notable queue" bar) the full budget
 * applies; at HIGH (the uWS default `maxBackpressure`, where the adapter starts
 * shedding frames outright) the budget floors at 1 - the innermost entity still
 * flows, and a socket this wedged is about to be degraded by the transport
 * anyway. Linear in between: congestion sheds the fringe first, smoothly,
 * instead of letting the transport drop arbitrary frames at the cliff.
 */
const _SMOOTH_BUDGET_BUFFERED_LOW = 65536;
const _SMOOTH_BUDGET_BUFFERED_HIGH = 1048576;

/**
 * Build the per-tick effective-budget reader for a topic with `interest.budget`
 * set: the configured ceiling, scaled by the subscriber socket's CURRENT
 * outbound queue depth. The read is per subscriber per tick (one native
 * `getBufferedAmount` getter - the same accessor the adapter's pressure sampler
 * walks); a platform whose sockets do not expose it (the deterministic sim, a
 * bare test double) reads as unbuffered and keeps the full budget, so the pure
 * relevancy pass stays deterministic wherever the transport is.
 * @param {any} rec @param {number} budget
 * @returns {(identity: string) => number | undefined}
 */
function _smoothBudgetOf(rec, budget) {
	return (identity) => {
		const ws = rec.registry.get(identity);
		if (ws === undefined) return budget;
		let buffered = 0;
		if (typeof ws.getBufferedAmount === 'function') {
			try { buffered = ws.getBufferedAmount(); } catch { buffered = 0; }
		}
		if (!(typeof buffered === 'number' && Number.isFinite(buffered)) || buffered <= _SMOOTH_BUDGET_BUFFERED_LOW) return budget;
		if (buffered >= _SMOOTH_BUDGET_BUFFERED_HIGH) return 1;
		const scale = 1 - (buffered - _SMOOTH_BUDGET_BUFFERED_LOW) / (_SMOOTH_BUDGET_BUFFERED_HIGH - _SMOOTH_BUDGET_BUFFERED_LOW);
		const b = Math.floor(budget * scale);
		return b >= 1 ? b : 1;
	};
}

/**
 * One-shot dev guard. When live.smooth() runs on a platform that does not
 * implement the binary wire (`publishWire`/`sendWire`), the tick degrades to
 * plain JSON frames: peers still see each other and per-subscriber interest
 * culling still applies (the relevancy walk is independent of the wire), but the
 * author is no longer excluded from its own echo on the shared broadcast path
 * (harmless - the client skips its own key) and frames are uncompacted JSON
 * instead of the binary encoding. Every published svelte-adapter-uws that carries
 * the smooth plugin also carries `publishWire`, so this only trips on a custom
 * transport that omits it or a bare test double - exactly where the silent
 * degrade is surprising. Fired once per process; the `_IS_DEV` gate short-circuits
 * the whole check in production (a single boolean read; a bundler that inlines
 * NODE_ENV drops it entirely), so the per-command path pays nothing.
 */
let _warnedLegacyFanout = false;

/** Test seam: re-arm the legacy-fan-out dev warning. @internal */
export function _resetSmoothFanoutWarning() {
	_warnedLegacyFanout = false;
}

function _warnLegacyFanout() {
	if (_warnedLegacyFanout) return;
	_warnedLegacyFanout = true;
	console.warn(
		'[svelte-realtime] live.smooth() is running on a platform without the binary wire (publishWire/sendWire). ' +
		'Smooth updates fall back to plain JSON frames: peers still see each other (interest culling still applies), but the ' +
		'author is not excluded from its own echo on the broadcast path and frames are uncompacted JSON. Use svelte-adapter-uws ' +
		'(or a platform that implements publishWire/sendWire) for the binary smooth wire.\n  See: https://svti.me/smooth'
	);
}

/**
 * Right-to-erasure purge: drop every identity-keyed trace one user holds
 * across ALL smooth topics - the subscriber registry entry (identity -> ws;
 * its socket's RTT tracker rides along via the WeakMap, reachable only while
 * the registry still holds the ws), cross-instance surrogates for the
 * identity, the interest state (reported center = a literal user location,
 * LOD memory, send cadence, last relevancy), and the lag-comp movement-history
 * ring when the entity key IS the identity. Entity state in the app's own
 * catalog is app data the app removes through its own ops.
 *
 * Returns the number of entries removed, for the forget cascade's per-surface
 * count. Called from the forget descriptor table.
 * @param {string} identity
 * @returns {number}
 */
export function _purgeSmoothUser(identity) {
	let count = 0;
	const surrogateSuffix = '\u0000' + identity;
	for (const rec of _smoothTopics.values()) {
		const ws = rec.registry.get(identity);
		if (ws !== undefined) {
			// Delete the RTT tracker FIRST (a measured-latency fingerprint):
			// the registry entry is the last strong reference that makes the
			// socket's WeakMap slot addressable by identity.
			_lcRtt.delete(ws);
			rec.registry.delete(identity);
			// Defensive like the interest/lagComp purges below: a record shape
			// missing the throttle map must not abort the rest of the erasure.
			if (rec.syncRate) rec.syncRate.delete(identity);
			count++;
		}
		for (const key of rec.surrogates.keys()) {
			if (key.endsWith(surrogateSuffix)) {
				rec.surrogates.delete(key);
				count++;
			}
		}
		if (rec.interest) count += rec.interest.purgeIdentity(identity);
		if (rec.lagComp) {
			const before = rec.lagComp.size;
			rec.lagComp.remove(identity);
			count += before - rec.lagComp.size;
		}
	}
	return count;
}

/** Test seam: clear every smooth record, pending sync, and armed tick. */
export function _resetSmooth() {
	for (const rec of _smoothTopics.values()) {
		if (rec.timer !== null) clearTimer(rec.timer);
		if (rec.pendingSync) {
			// Settle any suspended sync so its handler resumes (and does not orphan
			// the async frame) instead of merely dropping the timer.
			for (const p of rec.pendingSync.values()) {
				if (p.timer !== null) clearTimer(p.timer);
				p.resolve(null);
			}
			rec.pendingSync.clear();
		}
	}
	_smoothTopics.clear();
}

export function _smoothRecord(name, cfg, platform, rt) {
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
			// Broadcast cadence gate (broadcastHz): entity updates go on the wire
			// every Nth tick instead of every tick, the client interpolation covering
			// the widened gap. 1 (the default) is the byte-identical every-tick path.
			// `pendingWire` accumulates the movers of skipped ticks (key -> the LAST
			// tick's commanded flag, which decides the owner-echo exclusion at flush);
			// the send tick re-reads each mover's CURRENT authoritative state, so
			// skipped motion is coalesced, never lost.
			broadcastEvery: cfg.broadcastHz
				? Math.max(1, Math.round(1000 / cfg.tickMs / cfg.broadcastHz))
				: 1,
			tickNo: 0,
			pendingWire: new Map(),
			noEcho: cfg.noEcho,
			timer: null,
			// Cluster bookkeeping (unused on the single-instance path). `cfg` is
			// stashed so the module-level relay handlers can resolve a topic's
			// initial-state factory; `registry` maps a local subscriber's identity
			// to its socket (ack routing + author exclusion); `surrogates` caches
			// the owner-side stand-in socket per remote (instance, identity) so the
			// authority's by-reference ownership check holds across ticks;
			// `pendingSync` correlates a non-owner's in-flight sync request;
			// `eventSeq` is the owner's outbound broadcast counter; `lastSeenSeq` /
			// `lastSeenOwner` are the receiver's dedup watermark for the current
			// owner; `owned` is whether this instance currently holds the tick lease.
			cfg,
			registry: new Map(),
			surrogates: new Map(),
			pendingSync: new Map(),
			eventSeq: 0,
			// Outbound correlation id for events emitted by the shoot RPC's onHit (a
			// hit has no commanded apply, so it cannot borrow a command id). Distinct
			// from `eventSeq` (the cluster relay dedup counter); client-facing.
			shootEventSeq: 0,
			lastSeenSeq: -1,
			lastSeenOwner: null,
			lastRenew: 0,
			owned: false,
			// Owner wall-clock basis captured at a non-owner from inbound acks (which
			// carry the owner's `t`): a forwarding edge reconstructs the owner's clock
			// from this to measure a shot's latency on the owner's axis. Null until the
			// first ack with a `t` lands; read only on the forwarded-shoot path.
			lastOwnerT: null,
			lastOwnerWall: 0,
			// Warm-handoff snapshot state (opt-in; null/0 on the default path).
			// `lastSnap` throttles the owner's debounced write; `pendingSnapshot`
			// holds states recovered on acquire until each entity's real client
			// re-binds (consumed by `_smoothSeed`) - bounded per tenure and
			// grace-dropped via `pendingSnapshotAt`; `snapshotReady` is the
			// per-tenure once-and-barrier read promise (a concurrent sync awaits it
			// rather than seeding from initial mid-read).
			lastSnap: 0,
			pendingSnapshot: null,
			pendingSnapshotAt: 0,
			snapshotReady: null,
			// Area-of-interest relevancy (opt-in; null on the default path). When
			// set, the tick runs a per-subscriber relevancy pass before publishing
			// and delivers each subscriber only the entities in its area of interest.
			// `interestTick` is the monotonic counter that drives the LOD send
			// cadence (a tick count, not a clock - determinism seam). `interestDirty`
			// forces the next tick to run the relevancy pass even with no entity
			// motion, so a reported area-of-interest center (the `smooth-center`
			// frame) takes effect on a still board (a spectator panning the camera).
			interest: cfg.interest && !cfg.interest.cells ? createInterestState(cfg.interest) : null,
			interestTick: 0,
			interestDirty: false,
			// Per-identity re-sync allowance (see _smoothSyncAdmit). Entries follow
			// the registry's lifecycle (dropped on close / purge).
			syncRate: new Map(),
			// Spatial cell-topic interest (opt-in via interest.cells; null on the
			// per-client-interest path and the OFF path, so both stay byte-identical).
			// In cells mode area-of-interest is SUBSCRIPTION to grid-cell topics, not a
			// per-subscriber server-side cull: each changed entity is published to its
			// cell's topic via the stateless shared codec (one encode, native fan-out),
			// and each subscriber is server-subscribed to the cell block covering its
			// view. `entityCell` maps a key to its current cell key (for transition
			// removes), `subs` maps a subscriber identity to its currently-subscribed
			// cell set, `centers` holds an explicit reported center override (else the
			// subscriber's own entity position drives its block). `all` is the reserved
			// cell key for always-visible (null-position) entities every subscriber sees.
			cells: cfg.interest && cfg.interest.cells
				? {
					size: cfg.interest.cell || 256,
					radius: cfg.interest.radius,
					position: cfg.interest.position,
					codec: typeof rt.createCellWireCodec === 'function' ? rt.createCellWireCodec() : null,
					prefix: (rt.CELL_TOPIC_PREFIX || '__smoothcell:') + name + '#',
					entityCell: new Map(),
					subs: new Map(),
					centers: new Map(),
					// Under centerPolicy 'own-entity' the precedence at every consumption
					// site flips: a positioned own entity beats a stored center override,
					// so an override accepted while the connection was a spectator turns
					// inert the moment it owns an entity (no report-time race to exploit).
					ownFirst: cfg.interest.centerPolicy === 'own-entity',
					// A local subscriber's last-known own-entity position, maintained by
					// the sync placement and the ack / relayed-update follow legs. The
					// placement fallback for a node whose local authority holds no entity
					// (a cluster non-owner). Bounded by the local registry; released with
					// the subscriber.
					lastPos: new Map(),
					registered: false
				}
				: null,
			// Receive-side cull state (a cluster non-owner with interest on; empty and
			// untouched otherwise, so the OFF path and the owner path are byte-identical).
			// `shadow` is this instance's running view of every entity's last-known state -
			// seeded from the cold-join sync snapshot and updated from inbound relay frames -
			// so a non-owner can run the SAME relevancy cull the owner runs, delivering each
			// local subscriber only the relayed updates inside its area of interest while
			// never dropping a stationary in-range entity (the seed is what guarantees that).
			// `pendingRelay` holds the relay frames buffered since the last cull tick
			// (key -> { state, exclude }, where `exclude` is the author identity the owner
			// named for that frame); `shadowDirty` demand-arms the cull tick.
			shadow: new Map(),
			pendingRelay: new Map(),
			shadowDirty: false,
			// The shoot path's mode-agnostic area-of-interest view (per-client
			// relevancy or cell subscription), assigned right below when hitTest is
			// on - it closes over the record, so it cannot be built inside this
			// literal. Null otherwise (the OFF-path shape is unchanged).
			aoi: null,
			// The per-subscriber effective-budget reader (interest.budget), assigned
			// right below when the budget is set - same closes-over-the-record
			// reason as aoi. Null otherwise (uncapped, byte-identical).
			budgetOf: null,
			// The server world view for the onTick hook (server game logic: forces,
			// respawns, NPC drivers), assigned right below when onTick is configured.
			// Null otherwise - the tick pays one null check. The warn latches keep a
			// throwing hook / a key-collision warning to once per record in dev.
			world: null,
			worldThrowWarned: false,
			worldEnsureWarned: false,
			// Lag-compensation history ring (opt-in; null on the default path). When
			// set, the tick records the post-drain catalog here and the __smoothShoot
			// RPC rewinds against it. Gated entirely on cfg.hitTest so the OFF path is
			// byte-identical and zero-cost. The RING (record/rewind) is written
			// and read only on the owner; on a non-owner the object still exists (created
			// from cfg.hitTest) and the receive-side cull reads it as a `!== null` gate to
			// decide whether to run the send-cadence estimator.
			lagComp: cfg.hitTest
				? createLagComp({
						position: cfg.hitTest.position,
						tickMs: cfg.tickMs,
						maxRewindMs: cfg.hitTest.maxRewindMs,
						teleportThreshold: cfg.hitTest.teleportThreshold
					})
				: null,
			// Monotonic clock for the ring axis: the tick records and the shot handler
			// rewinds through this, so a server wall-clock backstep (NTP / live-migration)
			// can never feed the ring a timestamp older than its newest. Zero offset in
			// normal operation (the ring axis is the wall clock), so the OFF and the
			// common path stay byte-identical. Paired with lagComp (same hitTest gate).
			monoClock: cfg.hitTest ? createMonotonicClock() : null,
			// The last tick this topic had live motion. A hitTest topic keeps ticking
			// (recording the still board) for one rewind window past this, so the
			// demand-armed idle never leaves a gap in the ring a rewind could span.
			lagCompLastActive: 0
		};
		// hitTest reads candidates / radius / interp-delay through one accessor so
		// the shot handlers never branch on the interest mode (per-client vs cells).
		if (cfg.hitTest) rec.aoi = _smoothAoi(rec);
		// Per-subscriber delivery ceiling (interest.budget): the effective-budget
		// reader the relevancy pass consults, scaled live by each subscriber
		// socket's outbound queue. Null (the default) keeps the pass uncapped and
		// byte-identical. Closes over the record (it reads the live registry), so
		// it cannot be built inside the literal - the aoi precedent above.
		if (rec.interest !== null && cfg.interest && cfg.interest.budget) {
			rec.budgetOf = _smoothBudgetOf(rec, cfg.interest.budget);
		}
		if (cfg.onTick) {
			// Version gate: the world view needs the authority's server-entity
			// surface. Feature-detected (not version-compared) so a custom runtime
			// that implements it passes; an old adapter fails actionably here - the
			// first sync/command for the topic - rather than deep in a tick.
			if (typeof rec.authority.set !== 'function') {
				throw new LiveError(
					'INTERNAL',
					'live.smooth() onTick requires svelte-adapter-uws 0.6.0-next.47 or newer (the installed adapter authority has no server-entity surface)'
				);
			}
			rec.world = _smoothWorld(rec);
		}
		_smoothTopics.set(name, rec);
	}
	// Capture the reserved prefixes once so the cluster relay handlers can resolve
	// a wire topic back to its record through `_smoothTopics` (no second index to
	// drift across HMR).
	_smoothPrefix = rt.SMOOTH_TOPIC_PREFIX;
	_smoothCellPrefix = rt.CELL_TOPIC_PREFIX || '__smoothcell:';
	// The record follows the caller's live platform: dev-server restarts and
	// multi-platform test processes otherwise publish into a dead instance.
	rec.platform = platform;
	// A codec topic on a platform that cannot do the binary wire silently degrades
	// to JSON (and loses author-exclusion on the broadcast path) - warn once in dev
	// so a partial or custom platform surfaces it. `_IS_DEV` gates the whole check
	// so production short-circuits on the first term.
	if (_IS_DEV && rec.codec && typeof platform.publishWire !== 'function') _warnLegacyFanout();
	return rec;
}

function _smoothResolveInitial(cfg, key) {
	return typeof cfg.initial === 'function' ? cfg.initial(key) : cfg.initial;
}

/**
 * The seed state for a first-`ensure` of `key`: a state recovered from the
 * warm-handoff snapshot when one is pending for this key (consumed so each
 * recovered entity seeds exactly once, the moment its real client re-binds),
 * otherwise the declared `initial`. With no pending snapshot - the default
 * path - this is exactly `_smoothResolveInitial(rec.cfg, key)`.
 * @param {any} rec @param {string} key
 */
function _smoothSeed(rec, key) {
	if (rec.pendingSnapshot !== null && rec.pendingSnapshot.has(key)) {
		const state = rec.pendingSnapshot.get(key);
		rec.pendingSnapshot.delete(key);
		return state;
	}
	return _smoothResolveInitial(rec.cfg, key);
}

/** Clear a record's warm-handoff state so a re-acquire reads the snapshot fresh. */
function _smoothClearSnapshotState(rec) {
	rec.snapshotReady = null;
	rec.pendingSnapshot = null;
	rec.pendingSnapshotAt = 0;
	rec.lastSnap = 0;
}

/**
 * Load this tenure's snapshot into `rec.pendingSnapshot` exactly once, returning
 * a promise that resolves when it is ready. The first caller performs the read;
 * a concurrent caller (a second sync, or a relay handler once ownership is
 * published) gets the SAME in-flight promise, so none seeds an entity from
 * `initial` while the read is still in flight. Caller gates on `rec.cfg.snapshot`;
 * a coordinator without `readSnapshot` resolves immediately (inert).
 * @param {any} rec @param {any} cluster @returns {Promise<void>}
 */
function _smoothLoadSnapshot(rec, cluster) {
	if (rec.snapshotReady !== null) return rec.snapshotReady;
	if (typeof cluster.readSnapshot !== 'function') {
		rec.snapshotReady = Promise.resolve();
		return rec.snapshotReady;
	}
	rec.snapshotReady = (async () => {
		let snap = null;
		try { snap = await cluster.readSnapshot(rec.wireTopic); } catch { snap = null; }
		if (Array.isArray(snap) && snap.length > 0) {
			const pending = new Map();
			for (let i = 0; i < snap.length; i++) {
				const entry = snap[i];
				if (entry && typeof entry.key === 'string') pending.set(entry.key, entry.state);
			}
			if (pending.size > 0) {
				rec.pendingSnapshot = pending;
				rec.pendingSnapshotAt = wallEpoch();
			}
		}
	})();
	return rec.snapshotReady;
}

/**
 * The owner's snapshot payload: the live catalog plus any recovered states whose
 * client has not re-bound yet, so a second failover before they reconnect still
 * recovers them (the catalog holds only entities ensured into the authority; a
 * pending entry is consumed - removed - the instant its client re-binds, so the
 * two sets are disjoint).
 * @param {any} rec @returns {Array<{ key: string, state: any }>}
 */
function _smoothSnapshotPayload(rec) {
	const catalog = rec.authority.catalog();
	if (rec.pendingSnapshot === null || rec.pendingSnapshot.size === 0) return catalog;
	const out = catalog.slice();
	for (const [key, state] of rec.pendingSnapshot) out.push({ key, state });
	return out;
}

// --- The wire view (config `wire`) -----------------------------------------
// An app-owned codec pair applied at the CLIENT wire boundary and nowhere
// else: states pack in `_smoothPublish` / `_smoothSendTo` / `_smoothPublishCell`
// and the sync-reply roster; commands unpack at the command and shoot RPC
// entries. Everything internal - the authority, the lag-compensation ring,
// interest culling, the cluster relay, the shadow catalog, the warm-handoff
// snapshot - runs on the full state, so every instance culls and rewinds
// against real coordinates and packs independently at its own client edge.

/** Pack one state for the client wire (identity without a `wire.state` codec). */
function _smoothWireState(rec, state) {
	const w = rec.cfg.wire;
	return w !== undefined && w.state !== undefined ? w.state.pack(state) : state;
}

/** Pack a sync-reply roster for the client wire. */
function _smoothWireStates(rec, states) {
	const w = rec.cfg.wire;
	if (w === undefined || w.state === undefined || !Array.isArray(states)) return states;
	const out = new Array(states.length);
	for (let i = 0; i < states.length; i++) {
		out[i] = { key: states[i].key, state: w.state.pack(states[i].state) };
	}
	return out;
}

/** Rebuild a frame payload with its state packed, for the frames that carry
 * one: an update's `data`, an ack's `state`. Every other event passes through. */
function _smoothWireFrame(rec, event, data) {
	const w = rec.cfg.wire;
	if (w === undefined || w.state === undefined || data === null || typeof data !== 'object') return data;
	if (event === 'update') return { ...data, data: w.state.pack(data.data) };
	if (event === 'ack') return { ...data, state: w.state.pack(data.state) };
	return data;
}

function _smoothPublish(rec, event, data, excludeWs) {
	const platform = rec.platform;
	data = _smoothWireFrame(rec, event, data);
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
	data = _smoothWireFrame(rec, event, data);
	if (rec.codec && typeof platform.sendWire === 'function') {
		platform.sendWire(ws, rec.wireTopic, event, data, rec.codec);
	} else if (typeof platform.send === 'function') {
		platform.send(ws, rec.wireTopic, event, data, { compress: false });
	}
}

/**
 * Broadcast one tick's update frames. On a platform with the batched wire
 * fan-out, every update travels in ONE frame per capable viewer (per-entry
 * author exclusion and the per-entry JSON envelopes handled inside the
 * platform walk); an older platform, a single update, or a codec-less record
 * take the per-entity path unchanged. Entries: { key, state, excludeWs? }.
 */
function _smoothPublishUpdates(rec, list) {
	if (list.length === 0) return;
	const platform = rec.platform;
	if (rec.codec && list.length > 1 && typeof platform.publishWireBatch === 'function') {
		const entries = new Array(list.length);
		for (let i = 0; i < list.length; i++) {
			entries[i] = {
				data: _smoothWireFrame(rec, 'update', { key: list[i].key, data: list[i].state }),
				excludeWs: list[i].excludeWs
			};
		}
		platform.publishWireBatch(rec.wireTopic, 'update', entries, rec.codec);
		return;
	}
	for (let i = 0; i < list.length; i++) {
		_smoothPublish(rec, 'update', { key: list[i].key, data: list[i].state }, list[i].excludeWs);
	}
}

/**
 * Deliver one subscriber's culled update set. On a platform with the batched
 * single-target wire send, the whole set is one frame; otherwise the
 * per-entity sends this call replaces. Entries: { key, state }.
 */
function _smoothSendUpdatesTo(rec, ws, list) {
	if (list.length === 0) return;
	const platform = rec.platform;
	if (rec.codec && list.length > 1 && typeof platform.sendWireBatch === 'function') {
		const entries = new Array(list.length);
		for (let i = 0; i < list.length; i++) {
			entries[i] = { data: _smoothWireFrame(rec, 'update', { key: list[i].key, data: list[i].state }) };
		}
		platform.sendWireBatch(ws, rec.wireTopic, 'update', entries, rec.codec);
		return;
	}
	for (let i = 0; i < list.length; i++) {
		_smoothSendTo(rec, ws, 'update', { key: list[i].key, data: list[i].state });
	}
}

function _armSmoothTick(rec) {
	if (rec.timer !== null) return;
	rec.timer = setTimer(() => {
		rec.timer = null;
		_smoothTick(rec);
	}, rec.tickMs);
}

// --- Spatial cell-topic interest helpers (cells mode) ---------------------
// Reached only when a topic opted into `interest: { cells: true }`. On every
// other path `rec.cells` is null and none of this runs, so the per-client
// interest path and the OFF path stay byte-identical.

/** The cell key "cx,cy" for a position under the topic's cell size. */
function _cellKeyAt(cells, x, y) {
	return Math.floor(x / cells.size) + ',' + Math.floor(y / cells.size);
}

/**
 * The set of cell keys covering the square block [center +- (radius + extra)].
 * `extra` widens the block for hysteresis: the keep-set uses a one-cell margin so
 * a subscriber hovering on a boundary does not thrash subscribe/unsubscribe.
 * @returns {Set<string>}
 */
function _cellBlock(cells, x, y, extra) {
	const r = cells.radius + extra;
	const s = cells.size;
	const cx0 = Math.floor((x - r) / s), cx1 = Math.floor((x + r) / s);
	const cy0 = Math.floor((y - r) / s), cy1 = Math.floor((y + r) / s);
	const out = new Set();
	for (let cy = cy0; cy <= cy1; cy++) {
		for (let cx = cx0; cx <= cx1; cx++) out.add(cx + ',' + cy);
	}
	return out;
}

/** Publish a cell-scoped frame (update / remove) via the stateless shared codec. */
function _smoothPublishCell(rec, cellKey, event, data) {
	const cells = rec.cells;
	const platform = rec.platform;
	data = _smoothWireFrame(rec, event, data);
	const topic = cells.prefix + cellKey;
	if (cells.codec && typeof platform.publishWire === 'function') {
		if (!cells.registered && typeof platform.registerWireCodec === 'function') {
			platform.registerWireCodec(cells.codec);
			cells.registered = true;
		}
		platform.publishWire(topic, event, data, cells.codec);
	} else if (typeof platform.publish === 'function') {
		platform.publish(topic, event, data, { compress: false });
	}
}

/**
 * Cross-node leg of a cell publish: a cluster OWNER relays the frame (with its
 * cell topic) over the smooth coordinator so every other instance can republish
 * it to ITS local cell subscribers. Rides the same relay - and the same
 * `rec.eventSeq` counter - as the base-topic broadcasts, so the receiver's
 * per-owner seq watermark covers base and cell frames alike, in channel order.
 * A no-op single-instance and on a non-owner (byte-identical to before).
 */
function _smoothRelayCell(rec, cellKey, event, data) {
	const cluster = rec.platform && rec.platform.smooth;
	if (cluster && rec.owned && typeof cluster.relayBroadcast === 'function') {
		cluster.relayBroadcast(rec.cells.prefix + cellKey, event, data, undefined, rec.eventSeq++);
	}
}

/**
 * Route one entity update to its cell topic. On a cell transition, first tell the
 * old cell's subscribers to drop the entity (a subscriber of only the old cell
 * would otherwise keep a stale copy). A subscriber of BOTH cells resolves the
 * remove/update pair by its own per-cell bookkeeping (a remove only drops the
 * entity if it has not since been re-placed in another cell - client side).
 */
function _smoothCellUpdate(rec, key, state, t) {
	const cells = rec.cells;
	let cellKey = 'all';
	const p = cells.position(state);
	if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
		cellKey = _cellKeyAt(cells, p.x, p.y);
	}
	const prev = cells.entityCell.get(key);
	if (prev !== undefined && prev !== cellKey) {
		_smoothPublishCell(rec, prev, 'remove', { key });
		_smoothRelayCell(rec, prev, 'remove', { key });
	}
	cells.entityCell.set(key, cellKey);
	_smoothPublishCell(rec, cellKey, 'update', { key, data: state, t });
	_smoothRelayCell(rec, cellKey, 'update', { key, data: state, t });
}

/** Publish an entity removal to its last-known cell and forget it. */
function _smoothCellRemove(rec, key) {
	const prev = rec.cells.entityCell.get(key);
	if (prev !== undefined) {
		_smoothPublishCell(rec, prev, 'remove', { key });
		_smoothRelayCell(rec, prev, 'remove', { key });
		rec.cells.entityCell.delete(key);
	}
}

/**
 * Server-driven cell subscription: subscribe `ws` to the cell block covering
 * (x, y) plus the always-visible `all` cell, and unsubscribe cells it left
 * (outside the hysteresis keep-block). A no-op delta touches no sockets, so a
 * stationary subscriber pays nothing after its first placement, and a subscriber
 * count rising never adds to the per-tick ENCODE cost (that stays O(cells)).
 */
function _updateCellSubs(rec, identity, ws, x, y) {
	if (!ws) return;
	const cells = rec.cells;
	const platform = rec.platform;
	if (typeof platform.subscribe !== 'function') return;
	let cur = cells.subs.get(identity);
	if (cur === undefined) { cur = new Set(); cells.subs.set(identity, cur); }
	const want = _cellBlock(cells, x, y, 0);
	want.add('all');
	const keep = _cellBlock(cells, x, y, cells.size); // one-cell hysteresis margin
	keep.add('all');
	for (const ck of want) {
		if (!cur.has(ck)) { platform.subscribe(ws, cells.prefix + ck); cur.add(ck); }
	}
	for (const ck of cur) {
		if (!keep.has(ck)) {
			if (typeof platform.unsubscribe === 'function') platform.unsubscribe(ws, cells.prefix + ck);
			cur.delete(ck);
		}
	}
}

/**
 * Place a subscriber's cell block from its explicit reported center if it has one,
 * else from its own entity's current position, else from its last-known own
 * position (`cells.lastPos` - the fallback for a cluster non-owner, whose local
 * authority holds no entity). Called on join, on center report, and (for
 * own-entity followers) as the entity moves. Under centerPolicy 'own-entity' the
 * precedence flips: a positioned own entity (or lastPos) beats the override, so
 * only a connection with no entity anywhere resolves through its report.
 */
function _placeCellSubscriber(rec, identity, ws) {
	if (!ws) return;
	const cells = rec.cells;
	const center = cells.centers.get(identity);
	if (center !== undefined && !cells.ownFirst) {
		_updateCellSubs(rec, identity, ws, center.x, center.y);
		return;
	}
	const own = rec.authority.get(identity);
	if (own !== undefined) {
		const p = cells.position(own.state);
		if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
			_updateCellSubs(rec, identity, ws, p.x, p.y);
			return;
		}
	}
	const last = cells.lastPos.get(identity);
	if (last !== undefined) {
		_updateCellSubs(rec, identity, ws, last.x, last.y);
		return;
	}
	if (center !== undefined) _updateCellSubs(rec, identity, ws, center.x, center.y);
}

/**
 * Own-entity follow from an authoritative state that arrived OFF the local tick
 * (a cluster non-owner's ack, or a relayed cell update for a local identity):
 * record the position and, unless a reported center overrides it, re-place the
 * subscriber's cell block from it. The non-owner counterpart of the tick's
 * own-entity follow.
 */
function _smoothCellFollow(rec, identity, ws, state) {
	if (!ws) return;
	const cells = rec.cells;
	const p = cells.position(state);
	if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
	let last = cells.lastPos.get(identity);
	if (last === undefined) { last = { x: p.x, y: p.y }; cells.lastPos.set(identity, last); }
	else { last.x = p.x; last.y = p.y; }
	// Under 'own-entity' the entity always drives the block (a stored override is
	// inert for an entity owner); otherwise a reported center wins.
	if (cells.ownFirst || !cells.centers.has(identity)) _updateCellSubs(rec, identity, ws, p.x, p.y);
}

/** Drop a departed subscriber's cell bookkeeping. The platform auto-unsubscribes
 * a closed socket, so this only frees the maps. */
function _releaseCellSubs(rec, identity) {
	rec.cells.subs.delete(identity);
	rec.cells.centers.delete(identity);
	rec.cells.lastPos.delete(identity);
}

/**
 * The join snapshot for a cells-mode subscriber, scoped to its area of interest:
 * only entities in the cell block covering its view (plus always-visible ones),
 * not the whole roster. This is what keeps join O(block) instead of O(entities) -
 * a full-catalog snapshot to every joiner is the O(n^2) roster fanout at
 * population scale, and it matches exactly the cells the socket is subscribed to
 * (so a stationary in-block entity that sends no ongoing delta is still seen on
 * join). A subscriber with no resolvable center is delivered the whole board (the
 * same over-deliver polarity per-client interest holds for an unreported center),
 * and its OWN entity is always included - it is the client's reconciliation
 * basis, so a far reported center (a free-cam spectator whose entity waits
 * elsewhere) must never exclude it. `catalog` overrides the local authority as
 * the roster source - a cluster non-owner scopes the owner's sync-reply catalog
 * with it (its own authority is empty there).
 */
function _smoothCellSnapshot(rec, identity, catalog) {
	const cells = rec.cells;
	const full = catalog !== undefined ? catalog : rec.authority.catalog();
	// Resolve the joiner's center: reported override, else its own entity in the
	// roster being scoped (not the local authority, which is empty on a cluster
	// non-owner scoping the owner's reply). Under centerPolicy 'own-entity' the
	// precedence flips - a positioned own entity beats the override.
	const override = cells.centers.get(identity);
	let center = cells.ownFirst ? undefined : override;
	if (center === undefined) {
		for (let i = 0; i < full.length; i++) {
			if (full[i].key !== identity) continue;
			const p = cells.position(full[i].state);
			if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) center = { x: p.x, y: p.y };
			break;
		}
	}
	if (center === undefined && cells.ownFirst) center = override;
	if (center === undefined) return full; // no center -> whole board (safe over-deliver)
	const block = _cellBlock(cells, center.x, center.y, 0);
	const out = [];
	for (let i = 0; i < full.length; i++) {
		const e = full[i];
		if (e.key === identity) {
			out.push(e); // the joiner's own entity: its reconciliation basis
			continue;
		}
		const p = cells.position(e.state);
		if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
			out.push(e); // always-visible entity: everyone sees it (the `all` cell)
			continue;
		}
		if (block.has(_cellKeyAt(cells, p.x, p.y))) out.push(e);
	}
	return out;
}

/**
 * The caller's own-entity position as THIS instance can resolve it: the local
 * authority (owner / single instance), else the receive-side view a cluster
 * non-owner maintains (the interest shadow, or the cells follow's lastPos).
 * Null when the identity owns no entity here or its position is unresolvable
 * (an always-visible entity cannot anchor a clamp).
 * @param {any} rec @param {string} key
 * @returns {{ x: number, y: number } | null}
 */
function _smoothOwnPos(rec, key) {
	const posFn = rec.cells ? rec.cells.position : rec.cfg.interest.position;
	const own = rec.authority.get(key);
	if (own !== undefined) {
		let p = null;
		try { p = posFn(own.state); } catch { p = null; }
		return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
	}
	if (rec.cells) {
		const last = rec.cells.lastPos.get(key);
		return last !== undefined ? { x: last.x, y: last.y } : null;
	}
	const shadowState = rec.shadow.get(key);
	if (shadowState !== undefined) {
		let p = null;
		try { p = posFn(shadowState); } catch { p = null; }
		if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
	}
	return null;
}

/**
 * Evaluate `interest.centerPolicy` for a shape-valid reported center. Returns
 * the point to apply, or null when the report is REJECTED. `'any'` (or unset)
 * accepts everything - today's behavior, byte-identical. `'own-entity'` rejects
 * a report from any connection whose identity resolves a positioned entity (the
 * radar gate for authoritative games); a connection with no entity - a
 * spectator / free-cam - reports freely. A callback decides per report:
 * `false` rejects, `true` accepts, a finite point substitutes (clamp instead of
 * reject). Anything else, including a throw, REJECTS - a broken policy must
 * never widen replication (fail-safe polarity). Evaluated on the instance that
 * received the report (centers are node-local; no relay path stores one).
 * @param {any} rec @param {any} ctx @param {string} key
 * @param {{ x: number, y: number }} center
 * @returns {{ x: number, y: number } | null}
 */
function _smoothCenterPolicy(rec, ctx, key, center) {
	const policy = rec.cfg.interest.centerPolicy;
	if (policy === undefined || policy === 'any') return center;
	const ownPos = _smoothOwnPos(rec, key);
	if (policy === 'own-entity') {
		return ownPos === null ? center : null;
	}
	let verdict;
	try {
		verdict = policy(ctx, { x: center.x, y: center.y }, ownPos);
	} catch {
		return null;
	}
	if (verdict === true) return center;
	if (
		verdict !== null && typeof verdict === 'object' &&
		typeof verdict.x === 'number' && typeof verdict.y === 'number' &&
		Number.isFinite(verdict.x) && Number.isFinite(verdict.y)
	) {
		return { x: verdict.x, y: verdict.y };
	}
	return null;
}

/**
 * The join-snapshot roster for a syncing subscriber: cell-block scoped in cells
 * mode, area-of-interest scoped under per-client interest, the whole catalog on
 * the broadcast path. Both scoped forms keep the whole-board fallback for an
 * unresolvable center and always include the joiner's own entity. Only for a
 * reply that goes straight to the joiner - the cluster owner's cross-instance
 * sync reply stays the full catalog (see onSync).
 */
function _smoothJoinSnapshot(rec, identity) {
	if (rec.cells) return _smoothCellSnapshot(rec, identity);
	if (rec.interest !== null) return rec.interest.snapshotFor(identity, rec.authority.catalog());
	return rec.authority.catalog();
}

/**
 * The sync reply's wire-packed roster, always built fresh.
 *
 * Deliberately NOT cached. A cached roster is a snapshot of `e.state` values,
 * and the authority REPLACES those objects on every command, so a reused roster
 * hands back stale positions. The deltas do not repair it either: a tick only
 * carries entities whose state changed THAT tick, so an entity that moved during
 * the cache window and then stopped is never re-sent and the client stays wrong
 * until it moves again. That lands squarely on the reconnect case a re-sync
 * exists to serve. The flood this function used to be throttled against is
 * bounded by `_SMOOTH_SYNC_MAX_PER_WINDOW` at the RPC instead, which also caps
 * the reply serialization a cache could never remove.
 */
function _smoothSyncRoster(rec, identity) {
	return _smoothWireStates(rec, _smoothJoinSnapshot(rec, identity));
}

/**
 * Per-connection re-sync admission. Returns false when this identity has
 * already spent its allowance for the current window.
 *
 * A NEGATIVE elapsed (a backwards clock step) rolls the window over rather than
 * comparing against a future timestamp - otherwise a single step could pin the
 * window open and lock a legitimate client out for as long as the skew lasts.
 * Rolling over fails open for one window, which is the safe direction: the
 * attacker does not control the server clock, and a stuck-closed limiter would
 * break reconnects.
 *
 * A PINNED clock (the deterministic-simulation seams hold `wallEpoch` constant)
 * gives `elapsed === 0`, which never rolls the window over - so the allowance is
 * spent once and never refills. That is deliberate: a simulation replays a fixed
 * script rather than flooding, and silently disabling the limiter under the seam
 * would mean the property under test is not the one that ships.
 */
function _smoothSyncAdmit(rec, identity) {
	const now = wallEpoch();
	let entry = rec.syncRate.get(identity);
	const elapsed = entry === undefined ? Infinity : now - entry.windowStart;
	if (entry === undefined || elapsed >= _SMOOTH_RESYNC_WINDOW_MS || elapsed < 0) {
		entry = { windowStart: now, count: 0 };
		rec.syncRate.set(identity, entry);
	}
	entry.count++;
	return entry.count <= _SMOOTH_SYNC_MAX_PER_WINDOW;
}

/**
 * Per-subscriber relevancy delivery: send each local subscriber only the entities
 * inside its area of interest this tick. Shared by the owner tick (authoritative
 * catalog + drained updates) and the non-owner receive-side cull (shadow catalog +
 * relayed updates), so the area-of-interest cull has ONE implementation and cannot
 * drift between the two sides.
 *
 * `moved` carries the entities that changed this tick, each with the author identity
 * to suppress for that frame (echo suppression): on the owner that is the commanded
 * author under noEcho, on the non-owner it is the exclude identity the owner stamped
 * onto the relay. An entity in range that did NOT move is delivered via `lookup`
 * (first-sight catch-up: the owner reads the authority, the non-owner its shadow),
 * and a subscriber's own entity is never caught up to itself
 * under noEcho. Only a remote frame advances the send-cadence estimator (a client
 * discards its own entity frame before measuring its interpolation delay).
 * @param {any} rec
 * @param {Map<string, Set<string>>} relevancy identity -> entity keys to deliver
 * @param {(key: string) => any} lookup current per-entity state, for catch-up
 * @param {Map<string, { state: any, exclude: string | undefined }>} moved entities that changed this tick
 * @param {number} t wall stamp for the send-cadence estimator (hitTest only)
 */
function _smoothDeliverCulled(rec, relevancy, lookup, moved, t) {
	for (const [identity, ws] of rec.registry) {
		const relSet = relevancy.get(identity);
		if (relSet === undefined) continue;
		let delivered = false;
		// This subscriber's whole culled set collects and flushes as ONE
		// batched frame (per-entity on an older platform).
		const toSend = [];
		for (const key of relSet) {
			const m = moved.get(key);
			let state;
			let exclude;
			if (m !== undefined) {
				state = m.state;
				exclude = m.exclude;
			} else {
				// First-sight catch-up: in range, no update of its own this tick.
				state = lookup(key);
				exclude = rec.noEcho ? key : undefined;
			}
			if (exclude !== undefined && identity === exclude) continue;
			if (state !== undefined) {
				toSend.push({ key, state });
				if (key !== identity) delivered = true;
			}
		}
		_smoothSendUpdatesTo(rec, ws, toSend);
		// Release what left this subscriber's range. Without it the client holds an
		// out-of-range entity until its TTL sweep reaps it, so panning an interest
		// center across a board inflates the received set well past the radius
		// subset and only sheds it once movement stops.
		const exited = rec.interest.exitsFor(identity);
		if (exited !== undefined) {
			for (let i = 0; i < exited.length; i++) {
				// Never evict the subscriber's own entity - it is always relevant to
				// itself regardless of where the reported center is looking.
				if (exited[i] !== identity) _smoothSendTo(rec, ws, 'remove', { key: exited[i] });
			}
		}
		// The cadence seed is the WIRE interval (tickMs widened by the broadcast
		// gate), not the sim interval - the estimator's cold-start guess must
		// match what a subscriber actually receives.
		if (delivered && rec.lagComp !== null) rec.interest.noteSend(identity, t, rec.tickMs * rec.broadcastEvery);
	}
}

/**
 * Non-owner receive-side cull tick. A non-owner does not tick the authority, so when
 * it has opted into interest it runs THIS instead of the owner tick: deliver each
 * local subscriber only the relayed updates inside its area of interest, computed
 * against the shadow catalog (seeded from the cold-join snapshot, updated from inbound
 * relays). Demand-armed - an inbound relay frame (`shadowDirty`) or a reported center
 * (`interestDirty`) arms it; it delivers once and does not re-arm. A no-op when there
 * is nothing to cull (still board, no subscribers, or an empty shadow). Reached only
 * for an interest topic on a non-owner; with interest off the broadcast path stays
 * immediate and this never runs.
 * @param {any} rec
 */
function _smoothCullTick(rec) {
	if (rec.interest === null) return;
	if (!(rec.shadowDirty || rec.interestDirty) || rec.registry.size === 0 || rec.shadow.size === 0) {
		rec.shadowDirty = false;
		rec.interestDirty = false;
		rec.pendingRelay.clear();
		return;
	}
	// The send-cadence stamp must be on the SAME clock axis the forwarded-shot path
	// reads it on. A non-owner resolves a forwarded shot against the owner's
	// reconstructed clock (_edgeOwnerNow), so stamp noteSend there too; fall back to
	// the local wall clock until the first ack establishes the owner-clock basis.
	// Only used when hitTest is on (noteSend is gated on rec.lagComp below).
	const t = rec.lagComp !== null ? (_edgeOwnerNow(rec) ?? wallEpoch()) : 0;
	const catalog = [];
	for (const [key, state] of rec.shadow) catalog.push({ key, state });
	const relevancy = rec.interest.compute(catalog, rec.registry.keys(), rec.interestTick++, rec.budgetOf ?? undefined);
	_smoothDeliverCulled(rec, relevancy, (key) => rec.shadow.get(key), rec.pendingRelay, t);
	rec.pendingRelay.clear();
	rec.shadowDirty = false;
	rec.interestDirty = false;
}

function _smoothTick(rec) {
	// Cluster owner: this instance ticks the topic's authority for clients across
	// the cluster. Local subscribers get the broadcast directly; remote ones get
	// it relayed (and their acks routed back). When falsy, the single-instance
	// path below runs unchanged.
	const cluster = rec.platform && rec.platform.smooth;
	// Clock fence: a fenced instance's wall clock is untrustworthy for the
	// rewind axis and the owner-stamped `t` on ack/sync frames, so a fenced
	// owner stands down through the same path a failed lease renewal takes -
	// fenced behaves like dead, and crash takeover is an already-shipped,
	// already-tested path. The lease is released proactively so a
	// healthy-clocked sibling claims immediately instead of waiting out the
	// TTL. Clustered mode only: fencing needs the cluster reference clock to
	// measure against, and a single instance has no sibling to hand off to.
	const clockFence = rec.platform && rec.platform.clockFence;
	let clockFenced = false;
	if (cluster && rec.owned && clockFence && typeof clockFence.fenced === 'function') {
		// Contained like the release below: the predicate is app/extension-
		// supplied, and a throw here would kill the tick permanently (the
		// timer only re-arms at the tail). An erroring fence reads unfenced.
		try { clockFenced = clockFence.fenced() === true; } catch { /* unfenced on error */ }
	}
	if (clockFenced) {
		rec.owned = false;
		_smoothClearSnapshotState(rec);
		if (typeof cluster.releaseOwner === 'function') {
			try {
				const r = cluster.releaseOwner(rec.wireTopic);
				if (r && typeof r.catch === 'function') r.catch(() => {});
			} catch { /* release is best-effort; the lease TTL is the backstop */ }
		}
		if (rec.registry.size === 0) {
			_smoothForget(rec);
			return;
		}
	}
	// A non-owner does not tick the authority (a demoted owner that lost the lease is
	// no longer authoritative and must not drain or relay stale state). When it has
	// opted into interest it runs a receive-side relevancy cull instead - delivering
	// each local subscriber only the relayed updates inside its area of interest. With
	// interest off the cull tick is a no-op and the non-owner stays on the immediate
	// broadcast path (byte-identical). Its local subscribers reconcile by re-syncing to
	// the new owner after a handoff.
	if (cluster && !rec.owned) {
		_smoothCullTick(rec);
		return;
	}
	// Drain first, publish after: `apply` is pure state -> state, so nothing
	// can publish mid-drain, and subscribers observe each tick atomically -
	// every update and acknowledgement below reflects the same drained state.
	const { updates, acks, events = [], idle } = rec.authority.drain();
	const t = wallEpoch();
	// Server world hook (the ticking instance only - a cluster non-owner
	// returned before the drain above). Runs post-drain so it reads the tick's
	// settled states; its writes merge into this tick's updates/acks and land
	// in the catalog taken below, so they broadcast, ring-record, and cull
	// atomically with the drain.
	const worldRun = rec.world !== null ? rec.world.run(updates, acks, t) : null;
	// Broadcast cadence gate (broadcastHz): the simulation keeps ticking at
	// tickMs - commands drain, acknowledgements return, events fire, the
	// lag-compensation ring records - but continuous entity updates go on the
	// wire only every broadcastEvery-th tick. The drain reports PER-TICK deltas,
	// so a skipped tick's movers are accumulated into `pendingWire` rather than
	// dropped, and the send tick re-reads each mover's CURRENT authoritative
	// state - motion across skipped ticks is coalesced into one frame, never
	// lost. The stored flag is the LAST tick's `commanded`: a trailing commanded
	// change was acknowledged with the final state (the owner already holds it,
	// so the echo exclusion may apply), a trailing onMissing/injected change was
	// not (the owner must receive the broadcast). An idle drain with pending
	// motion flushes immediately: the single-instance tick stops re-arming at
	// idle, and the final rest state must reach the viewers before it does. A
	// mover removed between accumulation and flush is skipped - its departure
	// was already broadcast by the remove path. Everything below the gate
	// consumes `wireUpdates`; on the default path it IS the drain's updates
	// array, so the every-tick behavior is byte-identical.
	let wireUpdates = updates;
	if (rec.broadcastEvery > 1) {
		for (let i = 0; i < updates.length; i++) {
			rec.pendingWire.set(updates[i].key, updates[i].commanded);
		}
		rec.tickNo++;
		if (rec.pendingWire.size > 0 && (rec.tickNo % rec.broadcastEvery === 0 || idle)) {
			wireUpdates = [];
			for (const [key, commanded] of rec.pendingWire) {
				const e = rec.authority.get(key);
				if (e === undefined) continue;
				wireUpdates.push({ key, state: e.state, ws: e.ws, commanded });
			}
			rec.pendingWire.clear();
		} else {
			wireUpdates = [];
		}
	}
	// Area-of-interest: when this topic opted into interest, build the relevancy
	// for THIS instance's local subscribers once per tick from the drained catalog
	// (which on a cluster owner spans every entity cluster-wide, local and remote
	// surrogate, so a local player still sees nearby remote players). The publish
	// loop then delivers each local subscriber only the updates inside its area of
	// interest. Null (skipped) when interest is off or there is nothing to publish,
	// so the broadcast-all path is byte-identical. The inter-instance relay below
	// still fans every update out to every instance (the owner cannot cull per remote
	// subscriber - it does not hold a remote subscriber's interest center); each
	// RECEIVING instance then runs the same relevancy cull over its own local
	// subscribers (_smoothCullTick), so the last hop to a remote client is culled too.
	// The relevancy is keyed by local identity via `rec.registry`,
	// which the single-instance sync/command paths now populate for interest too.
	// The catalog is the post-drain authoritative state of every entity, so it is
	// also the source for a delivery the relevancy pass forced but `updates` does
	// not carry (an entity a subscriber just moved into range of that did not move
	// itself this tick - the first-sight catch-up).
	// Run the relevancy pass when an entity moved (updates) OR a subscriber just
	// reported a new area-of-interest center (interestDirty) - the latter so a
	// spectator panning the camera over a still board still gets caught up.
	// The interest relevancy pass runs only on a moving / dirty tick (its existing
	// cadence). The lag-compensation ring, in contrast, must capture EVERY tick so a
	// stationary-but-targetable entity stays rewindable. Take the catalog once when
	// either wants it (one allocation when both are on), but compute relevancy only
	// on the interest cadence (so the interest LOD counter is unchanged when the
	// catalog was taken solely for lag compensation).
	const wantInterest = rec.interest !== null && (wireUpdates.length > 0 || rec.interestDirty);
	const catalog = (rec.lagComp !== null || wantInterest) ? rec.authority.catalog() : null;
	const relevancy = wantInterest
		? rec.interest.compute(catalog, rec.registry.keys(), rec.interestTick++, rec.budgetOf ?? undefined)
		: null;
	if (rec.lagComp !== null && catalog !== null) {
		// Key the ring on the monotonic axis (immune to a wall backstep); `t` (wall)
		// still drives the frame/ack stamps and the wall-axis idle grace below.
		rec.lagComp.record(catalog, rec.monoClock.mono(t));
		// World-driven motion counts as live motion for the grace window too.
		if (!idle || (worldRun !== null && worldRun.dirty)) rec.lagCompLastActive = t;
	}
	rec.interestDirty = false;
	// Broadcast updates collect here and flush as ONE batched fan-out after the
	// loop (per-entry author exclusion rides along); the relay and the cells
	// routing stay per-entity inside the loop. Allocated on first use: the
	// interest and cells paths never push (their delivery runs elsewhere).
	let broadcastUpdates = null;
	for (let i = 0; i < wireUpdates.length; i++) {
		const u = wireUpdates[i];
		// Cells mode: route each changed entity to its cell topic (native shared
		// fan-out), not the per-subscriber walk or the base broadcast. Egress is
		// O(cells), not O(subscribers). The mover's own cell subscription follows it
		// (unless it set an explicit reported center). No per-subscriber encode here,
		// so a rising subscriber count never adds to the per-tick encode cost.
		if (rec.cells) {
			_smoothCellUpdate(rec, u.key, u.state, t);
			const ws = rec.registry.get(u.key);
			// Under 'own-entity' the entity always drives the block (a stored
			// override is inert for an entity owner).
			if (ws && (rec.cells.ownFirst || !rec.cells.centers.has(u.key))) {
				const p = rec.cells.position(u.state);
				if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
					_updateCellSubs(rec, u.key, ws, p.x, p.y);
				}
			}
			continue;
		}
		// Echo suppression applies only to commanded updates: those owners get
		// their copy through the acknowledgement. onMissing-driven motion
		// produces no ack, so its owner must receive the broadcast or it
		// renders a frozen entity everyone else sees gliding.
		if (cluster) {
			// Local delivery: with interest on, the per-subscriber relevancy walk
			// below delivers to local subscribers (culled). Without it, the shared
			// fan-out broadcasts to all local subscribers, excluding the author's
			// local socket (a remote author resolves to undefined, so the owner's
			// own subscribers all see the move).
			if (!relevancy) {
				const localAuthor = rec.noEcho && u.commanded ? rec.registry.get(u.key) : undefined;
				(broadcastUpdates ??= []).push({ key: u.key, state: u.state, excludeWs: localAuthor });
			}
			// Relay to other instances. Only a remote (surrogate) author needs a
			// cross-instance exclude - a local author is already excluded (below, or
			// by the relevancy walk's own-update suppression) and is on no other
			// instance. The entity key IS the author identity.
			const relayExclude = rec.noEcho && u.commanded && _isSmoothSurrogate(u.ws) ? u.key : undefined;
			if (typeof cluster.relayBroadcast === 'function') {
				cluster.relayBroadcast(rec.wireTopic, 'update', { key: u.key, data: u.state }, relayExclude, rec.eventSeq++);
			}
		} else if (relevancy) {
			// Interest-on: updates fan out per subscriber after this loop (the
			// relevancy walk below), so nothing broadcasts here.
		} else {
			(broadcastUpdates ??= []).push({ key: u.key, state: u.state, excludeWs: rec.noEcho && u.commanded ? u.ws : undefined });
		}
	}
	// One tick, one fan-out: every collected update in a single batched frame
	// per capable viewer (per-entity on an older platform). Acks, events, and
	// removals keep their own frames below, exactly as before.
	if (broadcastUpdates !== null) _smoothPublishUpdates(rec, broadcastUpdates);
	// Interest-on: deliver each LOCAL subscriber (single-instance, or the owner
	// side of a cluster) the CURRENT state of every entity the relevancy pass marked
	// for it this tick - the entities inside its area of interest that changed since
	// it last saw them, plus any it just moved into range of (first-sight catch-up).
	// The state comes from this tick's update when the entity moved, else from the
	// post-drain catalog (the catch-up case, where the entity has no update of its
	// own). A subscriber's own entity is suppressed when noEcho is on EXCEPT for
	// onMissing motion: a commanded change is already in hand via the acknowledgement,
	// but server-side (onMissing) motion of the owner's entity produces no ack, so the
	// owner must receive it. Per-subscriber sends ride the binary codec, exactly as
	// the cursor viewport cull does. Events and removals stay on the shared broadcast
	// path (over-deliver rather than risk a ghost or a dropped one-shot).
	if (relevancy) {
		// `moved` carries each entity that changed this tick with the author to suppress
		// for that frame (the commanded author under noEcho). The shared delivery helper
		// catches up in-range entities that did not move straight from the authority
		// (`get` is O(1) and hands back the same state object the catalog carried -
		// nothing mutates entries between the post-drain snapshot and this delivery).
		// Only a remote frame advances the lag-comp send-cadence estimator (the client
		// discards its own entity frame before measuring its interpolation delay).
		const moved = new Map();
		for (let i = 0; i < wireUpdates.length; i++) {
			const u = wireUpdates[i];
			moved.set(u.key, { state: u.state, exclude: rec.noEcho && u.commanded ? u.key : undefined });
		}
		_smoothDeliverCulled(rec, relevancy, (key) => {
			const e = rec.authority.get(key);
			return e === undefined ? undefined : e.state;
		}, moved, t);
	}
	for (let i = 0; i < acks.length; i++) {
		const a = acks[i];
		// Remote client: its ack rides the relay back to the instance it is
		// connected to, which delivers it to the real socket. (A surrogate is
		// never a closed-ws ghost - a remote departure arrives as onLeave.)
		if (cluster && _isSmoothSurrogate(a.ws)) {
			if (typeof cluster.relayAck === 'function') {
				cluster.relayAck(rec.wireTopic, a.key, a.ws.originInstance, { id: a.id, state: a.state, t });
			}
			continue;
		}
		// Self-heal: an entity whose socket closed between enqueue and drain
		// is a ghost - remove it and broadcast its departure instead of
		// acknowledging into a freed handle.
		if (a.ws && _smoothClosedWs.has(a.ws)) {
			const removed = rec.authority.removeWs(a.ws);
			for (let j = 0; j < removed.length; j++) {
				// Mirror the close-drain cleanup so every entity-removal site holds the
				// same invariant: an entity removed => its registry + interest state
				// released (the entity key IS its owner identity).
				if (rec.interest) {
					rec.registry.delete(removed[j]);
					rec.interest.releaseSubscriber(removed[j]);
				}
				if (rec.cells) {
					rec.registry.delete(removed[j]);
					_releaseCellSubs(rec, removed[j]);
				}
				_smoothRelayRemove(rec, removed[j]);
			}
			continue;
		}
		_smoothSendTo(rec, a.ws, 'ack', { id: a.id, state: a.state, t });
	}
	// Discrete one-shot events last (after the positions they happened at and
	// the owner's authoritative copy). Author-exclude the owner's echo of an
	// event it already drew optimistically, EXCEPT when it must receive the
	// authoritative copy: `toAuthor` (a hit the victim has to see) and `global`
	// (the author needs the broadcast - and once interest culling lands a global
	// event routes to the base topic). Same discipline as the commanded-update
	// exclusion above. The wire frame carries only {type,key,data,id}; the
	// server-side ws/commanded/opts never cross the wire.
	for (let i = 0; i < events.length; i++) {
		const e = events[i];
		const authorIncluded = !!(e.opts && (e.opts.toAuthor || e.opts.global));
		const wire = { type: e.type, key: e.key, data: e.data, id: e.id };
		if (cluster) {
			// Local author excluded only when its socket is on THIS instance.
			const localExclude = !authorIncluded && rec.noEcho && e.commanded && !_isSmoothSurrogate(e.ws) ? e.ws : undefined;
			_smoothPublish(rec, 'event', wire, localExclude);
			// A remote author is excluded on its own instance via the relay
			// (the surrogate carries the author's identity).
			const relayExclude = !authorIncluded && rec.noEcho && e.commanded && _isSmoothSurrogate(e.ws) ? e.ws.identity : undefined;
			if (typeof cluster.relayBroadcast === 'function') {
				cluster.relayBroadcast(rec.wireTopic, 'event', wire, relayExclude, rec.eventSeq++);
			}
		} else {
			const excludeWs = !authorIncluded && rec.noEcho && e.commanded ? e.ws : undefined;
			_smoothPublish(rec, 'event', wire, excludeWs);
		}
	}
	// Owner: refresh the ownership lease while ticking so the lease only rotates
	// when this instance goes quiet or dies. Fire-and-forget on a coarse cadence;
	// losing the lease (Redis blip or a takeover) drops ownership and the next
	// sync re-establishes it.
	if (cluster && rec.owned && t - rec.lastRenew >= _SMOOTH_RENEW_MS && typeof cluster.renewOwner === 'function') {
		rec.lastRenew = t;
		cluster.renewOwner(rec.wireTopic).then((ok) => {
			if (ok) return;
			rec.owned = false;
			// Drop this tenure's warm-handoff state so a re-acquire reads the
			// snapshot fresh.
			_smoothClearSnapshotState(rec);
			// A demoted owner stops ticking (the top-of-tick bail) and ignores
			// inbound leaves (onLeave is owner-gated). If it has no local
			// subscriber, no future close will ever reclaim it, so its record and
			// surrogate entities would leak - forget it now. A demoted owner that
			// still has local subscribers is reclaimed when they re-sync or close.
			if (rec.registry.size === 0) _smoothForget(rec);
		}).catch(() => {});
	}
	// Owner with the snapshot opt-in: debounce-persist the topic state so a sibling
	// that takes over after this owner dies can resume entities from their last
	// state. Fire-and-forget on its own throttle (the same `t` the renew gate uses).
	if (cluster && rec.owned && rec.cfg.snapshot && typeof cluster.writeSnapshot === 'function') {
		// Past the grace window a still-absent recovered client has departed: drop
		// its pending state so the cache stays bounded and the snapshot tracks the
		// live roster.
		if (rec.pendingSnapshot !== null && t - rec.pendingSnapshotAt >= _SMOOTH_PENDING_GRACE_MS) {
			rec.pendingSnapshot = null;
		}
		// Only while the topic holds live entities (an emptied topic stops refreshing
		// and its snapshot self-expires via the coordinator TTL). The payload unions
		// the catalog with any not-yet-rebound recovered states so a second failover
		// before they reconnect still recovers them.
		if (rec.authority.size > 0 && t - rec.lastSnap >= rec.cfg.snapshotDebounceMs) {
			rec.lastSnap = t;
			cluster.writeSnapshot(rec.wireTopic, _smoothSnapshotPayload(rec)).catch(() => {});
		}
	}
	if (rec.authority.size === 0) {
		_smoothForget(rec);
		return;
	}
	// A cluster owner keeps ticking while it holds ANY entity, even when the
	// drain is idle: the tick is what renews the ownership lease, so an idle
	// holding owner must not stop or its lease would expire under it (an entity
	// with no commands and the default hold-position onMissing goes idle but must
	// stay owned). Single-instance keeps the original demand-armed behavior.
	if (cluster) {
		_armSmoothTick(rec);
	} else if (!idle || (worldRun !== null && worldRun.rearm)) {
		// World mutation, a pending world injection, or the hook returning true
		// (its explicit heartbeat) sustains the tick like drained motion does.
		_armSmoothTick(rec);
	} else if (rec.lagComp !== null && t - rec.lagCompLastActive < rec.cfg.hitTest.maxRewindMs) {
		// hitTest grace: keep recording the still board for one rewind window after
		// the last motion so a shot that rewinds into the just-gone-idle interval
		// brackets dense records (no mis-lerp across a tick gap). After the window
		// the ring's newest record is the still position and a later shot clamps to
		// it (a still world's current state IS what the shooter saw).
		_armSmoothTick(rec);
	}
}

/**
 * Close-path drain: remove every smooth entity owned by a closing socket,
 * broadcast its departure, and drop topic records that emptied out.
 * @param {any} ws
 */
export function _drainSmoothOnClose(ws) {
	if (_smoothTopics.size === 0) return;
	for (const [name, rec] of _smoothTopics) {
		const cluster = rec.platform && rec.platform.smooth;
		if (cluster) {
			// Unregister this socket as a local subscriber and, when this instance
			// does not own the topic, tell the owner the client left so it drops
			// the surrogate entity (the entity lives on the owner; the close fires
			// here on the forwarder).
			let identity;
			for (const [id, sub] of rec.registry) {
				if (sub === ws) { identity = id; break; }
			}
			if (identity !== undefined) {
				rec.registry.delete(identity);
				if (rec.syncRate) rec.syncRate.delete(identity);
				if (rec.interest) rec.interest.releaseSubscriber(identity);
				// Cells mode: free the departing subscriber's cell bookkeeping here
				// too (the platform auto-unsubscribes the closed socket) - mirroring
				// the single-instance branch below, so a churning cluster node does
				// not accrete subs/centers entries until topic teardown.
				if (rec.cells) _releaseCellSubs(rec, identity);
				if (!rec.owned && typeof cluster.relayLeave === 'function') {
					cluster.relayLeave(rec.wireTopic, identity, cluster.instanceId);
				}
			}
			// Owner: remove this socket's own (native) entities and broadcast.
			const removed = rec.authority.removeWs(ws);
			for (let i = 0; i < removed.length; i++) {
				_smoothRelayRemove(rec, removed[i]);
			}
			// Drop the record when nothing local remains: an owner with no entity
			// anywhere, a non-owner with no local subscriber left.
			if (rec.owned ? rec.authority.size === 0 : rec.registry.size === 0) {
				_smoothForget(rec);
			}
			continue;
		}
		const removed = rec.authority.removeWs(ws);
		for (let i = 0; i < removed.length; i++) {
			// A departed identity's re-sync allowance goes with it.
			if (rec.syncRate) rec.syncRate.delete(removed[i]);
			// Interest topics carry an identity -> socket map and per-subscriber band
			// state keyed by identity (the entity key IS the identity); drop both.
			if (rec.interest) {
				rec.registry.delete(removed[i]);
				rec.interest.releaseSubscriber(removed[i]);
			}
			// Cells mode: drop the departing subscriber's identity map + cell
			// bookkeeping (the platform auto-unsubscribes the closed socket).
			if (rec.cells) {
				rec.registry.delete(removed[i]);
				_releaseCellSubs(rec, removed[i]);
			}
			if (rec.lagComp !== null) rec.lagComp.remove(removed[i]);
			// The departure goes to the entity's cell topic in cells mode, else the
			// base broadcast.
			if (rec.cells) _smoothCellRemove(rec, removed[i]);
			else _smoothPublish(rec, 'remove', { key: removed[i] }, undefined);
		}
		if (rec.authority.size === 0) {
			if (rec.timer !== null) clearTimer(rec.timer);
			_smoothTopics.delete(name);
		}
	}
}

/** Is this `ws` slot an owner-side stand-in for a remote client (not a real socket)? */
function _isSmoothSurrogate(ws) {
	return !!(ws && ws.__smoothSurrogate);
}

/**
 * The OWNER's stable stand-in socket for a remote client. The authority only
 * compares its `ws` slot by reference, so caching one surrogate per (instance,
 * identity) lets a forwarded command keep ownership of its entity across ticks.
 * @param {any} rec @param {string} originInstance @param {string} identity
 */
function _smoothSurrogate(rec, originInstance, identity) {
	const k = originInstance + '\u0000' + identity;
	let s = rec.surrogates.get(k);
	if (s === undefined) {
		s = { __smoothSurrogate: true, identity, originInstance };
		rec.surrogates.set(k, s);
	}
	return s;
}

/**
 * Forget a record: cancel its tick, settle any pending sync, drop it from the
 * topics map, and release the ownership lease so a sibling can take over within
 * a renew cycle. Single-instance behavior is identical to a bare topic delete
 * (no pending sync, not an owner).
 * @param {any} rec
 */
function _smoothForget(rec) {
	if (rec.timer !== null) { clearTimer(rec.timer); rec.timer = null; }
	// Settle every suspended sync so its awaiting handler resumes (and hits its
	// CONNECTION_CLOSED liveness re-check) rather than hanging forever.
	for (const p of rec.pendingSync.values()) {
		if (p.timer !== null) clearTimer(p.timer);
		p.resolve(null);
	}
	rec.pendingSync.clear();
	if (rec.interest) rec.interest.reset();
	if (rec.cells) { rec.cells.entityCell.clear(); rec.cells.subs.clear(); rec.cells.centers.clear(); rec.cells.lastPos.clear(); }
	if (rec.lagComp !== null) rec.lagComp.reset();
	_smoothTopics.delete(rec.name);
	const cluster = rec.platform && rec.platform.smooth;
	if (rec.owned && cluster && typeof cluster.releaseOwner === 'function') {
		rec.owned = false;
		try { cluster.releaseOwner(rec.wireTopic); } catch { /* best-effort; the lease TTL is the safety net */ }
	}
}

/**
 * Broadcast an entity removal to local subscribers and, when this instance owns
 * the topic in a cluster, relay it so every other instance drops it too.
 * @param {any} rec @param {string} key
 */
function _smoothRelayRemove(rec, key) {
	if (rec.lagComp !== null) rec.lagComp.remove(key);
	// Cells mode: the removal goes to the entity's last-known cell topic, locally
	// and (owner) relayed to the other instances inside _smoothCellRemove. No
	// base-topic broadcast.
	if (rec.cells) { _smoothCellRemove(rec, key); return; }
	_smoothPublish(rec, 'remove', { key }, undefined);
	const cluster = rec.platform && rec.platform.smooth;
	if (cluster && rec.owned && typeof cluster.relayBroadcast === 'function') {
		cluster.relayBroadcast(rec.wireTopic, 'remove', { key }, undefined, rec.eventSeq++);
	}
}

/**
 * Ask the topic's owner for the catalog and resolve with its reply, or with
 * null if the owner does not answer within the timeout (the caller then returns
 * a local-empty basis and reconciles from incoming broadcasts).
 * @param {any} rec @param {any} cluster @param {string} identity @param {string} corr
 * @returns {Promise<any>}
 */
function _smoothRequestSync(rec, cluster, identity, corr) {
	return new Promise((resolve) => {
		const timer = setTimer(() => {
			rec.pendingSync.delete(corr);
			resolve(null);
		}, _SMOOTH_SYNC_TIMEOUT_MS);
		rec.pendingSync.set(corr, { resolve, timer });
		cluster.requestSync(rec.wireTopic, identity, cluster.instanceId, corr);
	});
}

/**
 * Wire the inbound relay handlers on a cluster coordinator, once per coordinator.
 * The handlers dispatch by wire topic to the live record and act only when this
 * instance has a stake in the topic (owns it, or has a local subscriber). A
 * frame for a topic this instance does not track is correctly ignored.
 * @param {any} smooth
 */
function _ensureSmoothCluster(smooth) {
	if (!smooth || typeof smooth.onMessage !== 'function' || _smoothClustersWired.has(smooth)) return;
	_smoothClustersWired.add(smooth);
	smooth.onMessage({
		// Owner: a non-owner forwarded a client's command batch. Ensure the
		// client's surrogate entity (idle until commands flow), drop ids the
		// authority has already acked (relay reorder/redelivery is then an
		// idempotent discard, not a re-apply), enqueue, and arm the tick.
		onCommand: (wireTopic, identity, originInstance, batch) => {
			const rec = _smoothRecByWire(wireTopic);
			if (!rec || !rec.owned || !Array.isArray(batch) || batch.length === 0) return;
			const surrogate = _smoothSurrogate(rec, originInstance, identity);
			let existing = rec.authority.get(identity);
			if (existing === undefined) {
				rec.authority.ensure(identity, surrogate, _smoothSeed(rec, identity));
				existing = rec.authority.get(identity);
			} else if (existing.ws !== surrogate) {
				// A newer sync re-owns this identity from another connection; a
				// command bound to the stale surrogate is ignored (one owning
				// socket per entity, the same rule the local command path holds).
				return;
			}
			const lastAcked = existing ? existing.lastAckedId : 0;
			const fresh = batch.filter((c) => c && typeof c.id === 'number' && c.id > lastAcked);
			if (fresh.length === 0) return;
			if (rec.authority.enqueue(identity, fresh)) _armSmoothTick(rec);
		},
		// Owner: a non-owner asked for the catalog on behalf of a cold-joining
		// client. Ensure its surrogate, answer with the client's basis + catalog.
		// The FULL catalog, not the joiner-scoped join snapshot: this reply also
		// seeds the requesting instance's receive-side shadow, which serves EVERY
		// local subscriber there - scoping it to this one joiner would under-seed
		// the others' cull (a stationary in-range entity would turn invisible).
		onSync: (wireTopic, identity, originInstance, corr) => {
			const rec = _smoothRecByWire(wireTopic);
			if (!rec || !rec.owned) return;
			const surrogate = _smoothSurrogate(rec, originInstance, identity);
			const ensured = rec.authority.ensure(identity, surrogate, _smoothSeed(rec, identity));
			if (typeof smooth.sendSyncReply === 'function') {
				smooth.sendSyncReply(wireTopic, corr, originInstance, { ack: ensured.lastAckedId, states: rec.authority.catalog() });
			}
		},
		// Requester: the owner answered our cold-join sync. Resolve the pending.
		onSyncReply: (wireTopic, corr, payload) => {
			const rec = _smoothRecByWire(wireTopic);
			if (!rec) return;
			const pending = rec.pendingSync.get(corr);
			if (!pending) return;
			rec.pendingSync.delete(corr);
			if (pending.timer !== null) clearTimer(pending.timer);
			pending.resolve(payload);
		},
		// Every instance: the owner relayed a broadcast. Drop a seen/regressing
		// seq (reset on an ownership handoff, since a fresh owner restarts the
		// counter), then deliver to local subscribers. With interest off, re-emit
		// immediately to all (excluding the author's local socket when the relay names
		// one) - byte-identical to the pre-cull behavior. With interest on, buffer
		// `update` frames into the shadow catalog and deliver them culled per local
		// subscriber on the cull tick; `event` and `remove` stay on the immediate
		// broadcast path (over-deliver rather than risk a ghost or a dropped one-shot),
		// matching the owner's policy. A CELL-topic frame (cells mode) is resolved
		// by its cell prefix and republished to this instance's own cell topic -
		// native local fan-out to exactly the sockets subscribed to that cell here,
		// never the base topic.
		onBroadcast: (wireTopic, event, data, excludeIdentity, seq, ownerInstance) => {
			const cellHit = _smoothCellRecByWire(wireTopic);
			if (cellHit !== null) {
				const rec = cellHit.rec;
				// The owner stamps base events and cell frames from ONE counter
				// (rec.eventSeq) on one in-order channel, so the record's per-owner
				// watermark covers both families.
				if (ownerInstance !== rec.lastSeenOwner) {
					rec.lastSeenOwner = ownerInstance;
					rec.lastSeenSeq = -1;
				}
				if (typeof seq === 'number') {
					if (seq <= rec.lastSeenSeq) return;
					rec.lastSeenSeq = seq;
				}
				// A live owner republishes nothing (its own publish already reached
				// local sockets; its own relays are instanceId-suppressed anyway).
				if (rec.owned) return;
				_smoothPublishCell(rec, cellHit.cellKey, event, data);
				// Own-entity follow: a relayed update for a LOCAL subscriber's own
				// entity re-places its cell block (the non-owner has no tick follow).
				// Covers server-driven (onMissing) motion; commanded motion is also
				// followed on the ack path.
				if (event === 'update' && data && typeof data.key === 'string') {
					const ws = rec.registry.get(data.key);
					if (ws !== undefined) _smoothCellFollow(rec, data.key, ws, data.data);
				}
				return;
			}
			const rec = _smoothRecByWire(wireTopic);
			if (!rec) return;
			if (ownerInstance !== rec.lastSeenOwner) {
				rec.lastSeenOwner = ownerInstance;
				rec.lastSeenSeq = -1;
			}
			if (typeof seq === 'number') {
				if (seq <= rec.lastSeenSeq) return;
				rec.lastSeenSeq = seq;
			}
			if (rec.interest !== null && !rec.owned) {
				if (event === 'update' && data && rec.registry.size > 0) {
					// Buffer into the shadow catalog (the non-owner's running view) and
					// arm the cull tick; the relayed `excludeIdentity` is the author the
					// owner stamped, carried through as the per-frame echo exclude.
					rec.shadow.set(data.key, data.data);
					rec.pendingRelay.set(data.key, { state: data.data, exclude: excludeIdentity });
					rec.shadowDirty = true;
					_armSmoothTick(rec);
					return;
				}
				if (event === 'remove' && data) {
					rec.shadow.delete(data.key);
					rec.pendingRelay.delete(data.key);
				}
			}
			const excludeWs = excludeIdentity !== undefined ? rec.registry.get(excludeIdentity) : undefined;
			_smoothPublish(rec, event, data, excludeWs);
		},
		// The commanding client's instance: deliver the owner's ack to its socket.
		onAck: (wireTopic, identity, payload) => {
			const rec = _smoothRecByWire(wireTopic);
			if (!rec) return;
			// Capture the owner's wall stamp (carried on every ack) so a non-owner can
			// reconstruct the owner's clock for an edge-measured forwarded shot. Gated
			// on hitTest so a non-lag-comp topic pays nothing.
			if (rec.cfg.hitTest !== undefined && payload && typeof payload.t === 'number' && Number.isFinite(payload.t)) {
				rec.lastOwnerT = payload.t;
				rec.lastOwnerWall = wallEpoch();
			}
			const ws = rec.registry.get(identity);
			if (ws !== undefined) {
				_smoothSendTo(rec, ws, 'ack', payload);
				// Cells mode: the ack carries the authoritative post-drain state, so a
				// non-owner follows its local subscriber's own entity from it (the
				// non-owner counterpart of the tick's own-entity follow).
				if (rec.cells && payload && payload.state !== undefined) {
					_smoothCellFollow(rec, identity, ws, payload.state);
				}
			}
		},
		// Owner: a remote client left. Drop its surrogate entity and broadcast
		// the removal so every instance forgets it.
		onLeave: (wireTopic, identity, originInstance) => {
			const rec = _smoothRecByWire(wireTopic);
			if (!rec || !rec.owned) return;
			const surrogate = rec.surrogates.get(originInstance + '\u0000' + identity);
			if (surrogate === undefined) return;
			rec.surrogates.delete(originInstance + '\u0000' + identity);
			const removed = rec.authority.removeWs(surrogate);
			for (let i = 0; i < removed.length; i++) {
				_smoothRelayRemove(rec, removed[i]);
			}
			if (rec.authority.size === 0) _smoothForget(rec);
		},
		// Owner: a non-owner forwarded a client's shot. Resolve it against the ring
		// using the EDGE-measured durations (reach width + rewind age) applied to the
		// owner's OWN present - never re-measuring across the inter-instance hop, which
		// would fold that hop into the window. The authoritative hit rides the owner's
		// existing event broadcast back to the shooter's instance, so a forwarded shot
		// needs no correlated reply.
		onShoot: (wireTopic, identity, originInstance, payload) => {
			const rec = _smoothRecByWire(wireTopic);
			if (!rec || !rec.owned || rec.lagComp === null) return;
			if (!payload || typeof payload !== 'object') return;
			const shooterEntity = rec.authority.get(identity);
			if (shooterEntity === undefined) return; // no entity here: this shooter cannot aim
			const ht = rec.cfg.hitTest;
			const reach = typeof payload.reach === 'number' && Number.isFinite(payload.reach)
				? Math.min(payload.reach, ht.maxRewindMs)
				: ht.maxRewindMs;
			const rewindAge =
				typeof payload.rewindAge === 'number' && Number.isFinite(payload.rewindAge) && payload.rewindAge >= 0
					? payload.rewindAge
					: null;
			// The detection signal fires from the edge-measured picture the owner cannot
			// recompute; a throwing hook never affects the shot.
			if (ht.detectionHook !== undefined && payload.detect && typeof payload.detect === 'object') {
				try {
					// Spread the forwarded picture first, then the trusted identity, so a
					// forged payload.detect.identity can never override the authoritative shooter.
					ht.detectionHook({ ...payload.detect, identity });
				} catch {
					/* observability only */
				}
			}
			const nowMono = rec.monoClock.mono(wallEpoch());
			const rewindAt = _smoothRewindAt(nowMono, reach, rewindAge);
			_smoothResolveShot(rec, rec.name, identity, shooterEntity, rec.platform, payload.cmd, rewindAt, nowMono).catch(() => {});
		}
	});
}

/**
 * Validate the `wire` config: an object whose optional `state` and `command`
 * entries each carry a pack/unpack function pair. An empty object normalizes
 * to undefined (the off path stays byte-identical).
 * @param {any} wire
 */
function _validateWire(wire) {
	if (wire === null || typeof wire !== 'object') {
		throw new Error('[svelte-realtime] live.smooth() wire must be an object with optional state and command codec pairs\n  See: https://svti.me/smooth');
	}
	for (const side of ['state', 'command']) {
		const pair = wire[side];
		if (pair === undefined) continue;
		if (pair === null || typeof pair !== 'object' || typeof pair.pack !== 'function' || typeof pair.unpack !== 'function') {
			throw new Error('[svelte-realtime] live.smooth() wire.' + side + ' must be { pack(value), unpack(packed) }');
		}
	}
	if (wire.state === undefined && wire.command === undefined) return undefined;
	return { state: wire.state, command: wire.command };
}

/**
 * Validate and normalize a `live.smooth({ interest })` config. Throws a
 * descriptive error on a malformed shape; returns the normalized interest the
 * relevancy pass consumes. `radius` and `position` are required when interest is
 * on (without a resolvable position there is nothing to cull on); `lod` bands,
 * when given, must be strictly ascending by `within` with an integer send-`rate`
 * of at least 1; `cell` tunes the spatial grid. `budget` is the per-subscriber
 * delivery ceiling (an integer of at least 1) the per-client cull enforces,
 * scaled down further for a backpressured socket; it applies to the per-client
 * interest mode only, so combining it with `cells` (which fans out per cell,
 * with no per-subscriber walk to bound) is a config contradiction and throws.
 * @param {any} it
 */
function _validateInterest(it) {
	if (it === null || typeof it !== 'object') {
		throw new Error('[svelte-realtime] live.smooth() interest must be an object\n  See: https://svti.me/smooth');
	}
	if (!(typeof it.radius === 'number' && Number.isFinite(it.radius) && it.radius > 0)) {
		throw new Error('[svelte-realtime] live.smooth() interest.radius must be a positive number');
	}
	if (typeof it.position !== 'function') {
		throw new Error('[svelte-realtime] live.smooth() interest.position must be a function (state) => ({ x, y }) | null');
	}
	if (it.cell !== undefined && !(typeof it.cell === 'number' && Number.isFinite(it.cell) && it.cell > 0)) {
		throw new Error('[svelte-realtime] live.smooth() interest.cell must be a positive number');
	}
	if (it.cells !== undefined && typeof it.cells !== 'boolean') {
		throw new Error('[svelte-realtime] live.smooth() interest.cells must be a boolean');
	}
	if (it.budget !== undefined) {
		if (!(typeof it.budget === 'number' && Number.isInteger(it.budget) && it.budget >= 1)) {
			throw new Error('[svelte-realtime] live.smooth() interest.budget must be an integer of at least 1');
		}
		if (it.cells === true) {
			throw new Error('[svelte-realtime] live.smooth() interest.budget applies to the per-client interest mode; cells mode fans out per cell and has no per-subscriber delivery walk to bound');
		}
	}
	if (
		it.centerPolicy !== undefined &&
		it.centerPolicy !== 'any' &&
		it.centerPolicy !== 'own-entity' &&
		typeof it.centerPolicy !== 'function'
	) {
		throw new Error(
			"[svelte-realtime] live.smooth() interest.centerPolicy must be 'any', 'own-entity', or a function (ctx, center, ownPos) => boolean | { x, y }"
		);
	}
	let lod;
	if (it.lod !== undefined) {
		if (!Array.isArray(it.lod) || it.lod.length === 0) {
			throw new Error('[svelte-realtime] live.smooth() interest.lod must be a non-empty array of { within, rate } bands');
		}
		let prev = 0;
		lod = it.lod.map((band) => {
			if (!band || typeof band !== 'object') {
				throw new Error('[svelte-realtime] live.smooth() interest.lod bands must be { within, rate } objects');
			}
			if (!(typeof band.within === 'number' && Number.isFinite(band.within) && band.within > 0)) {
				throw new Error('[svelte-realtime] live.smooth() interest.lod within must be a positive number');
			}
			if (!(typeof band.rate === 'number' && Number.isInteger(band.rate) && band.rate >= 1)) {
				throw new Error('[svelte-realtime] live.smooth() interest.lod rate must be an integer of at least 1');
			}
			if (band.within <= prev) {
				throw new Error('[svelte-realtime] live.smooth() interest.lod bands must be strictly ascending by within');
			}
			prev = band.within;
			return { within: band.within, rate: band.rate };
		});
	}
	return { radius: it.radius, position: it.position, lod, cell: it.cell, budget: it.budget, cells: it.cells === true, centerPolicy: it.centerPolicy };
}

/**
 * Validate and normalize a `hitTest` config (server-rewind lag compensation).
 * `hitTest` REQUIRES `interest`: the replicated set is the authoritative security
 * gate (you cannot rewind/hit an entity that was never replicated to the
 * shooter), so a hitTest without an interest set has no candidate gate and is
 * rejected at registration. Either interest mode provides the gate: per-client
 * relevancy membership, or - under `interest.cells` - the shooter's cell
 * subscription. The shot ray (`shot`) is always required - it
 * defines the geometry the framework rewinds around and hands to the narrowphase.
 * The narrowphase is either the declarative `hitbox` (circle/aabb, framework-
 * owned) or the `resolve` escape hatch (app-owned custom geometry); at least one
 * is required. `onHit` (the consequence - usually ctx.applyTo + ctx.emitEvent)
 * is always required. `position` defaults to interest.position.
 *
 * @param {any} ht
 * @param {{ position: Function } | undefined} interest the already-validated interest config
 */
function _validateHitTest(ht, interest) {
	if (ht === null || typeof ht !== 'object') {
		throw new Error('[svelte-realtime] live.smooth() hitTest must be an object\n  See: https://svti.me/smooth');
	}
	if (interest === undefined) {
		throw new Error(
			'[svelte-realtime] live.smooth() hitTest requires interest - the relevancy set is the lag-compensation security gate (you cannot hit what was never replicated to the shooter)\n  See: https://svti.me/smooth'
		);
	}
	if (typeof ht.onHit !== 'function') {
		throw new Error('[svelte-realtime] live.smooth() hitTest.onHit must be a function (ctx, target, info) => ...');
	}
	const shot = ht.shot;
	if (!shot || typeof shot !== 'object' || shot.type !== 'ray') {
		throw new Error("[svelte-realtime] live.smooth() hitTest.shot must be a { type: 'ray', origin, dir, maxDist } object");
	}
	if (typeof shot.origin !== 'function' || typeof shot.dir !== 'function') {
		throw new Error('[svelte-realtime] live.smooth() hitTest.shot.origin and shot.dir must be functions');
	}
	if (!(typeof shot.maxDist === 'number' && Number.isFinite(shot.maxDist) && shot.maxDist > 0)) {
		throw new Error('[svelte-realtime] live.smooth() hitTest.shot.maxDist must be a positive number');
	}
	const hasResolve = typeof ht.resolve === 'function';
	let hitbox;
	if (ht.hitbox !== undefined) {
		if (!ht.hitbox || typeof ht.hitbox !== 'object') {
			throw new Error('[svelte-realtime] live.smooth() hitTest.hitbox must be an object');
		}
		if (ht.hitbox.shape === 'circle') {
			if (!(typeof ht.hitbox.radius === 'number' && Number.isFinite(ht.hitbox.radius) && ht.hitbox.radius > 0)) {
				throw new Error('[svelte-realtime] live.smooth() hitTest.hitbox circle requires a positive radius');
			}
			hitbox = { shape: 'circle', radius: ht.hitbox.radius };
		} else if (ht.hitbox.shape === 'aabb') {
			if (!(typeof ht.hitbox.w === 'number' && ht.hitbox.w > 0 && typeof ht.hitbox.h === 'number' && ht.hitbox.h > 0)) {
				throw new Error('[svelte-realtime] live.smooth() hitTest.hitbox aabb requires positive w and h');
			}
			hitbox = { shape: 'aabb', w: ht.hitbox.w, h: ht.hitbox.h };
		} else {
			throw new Error("[svelte-realtime] live.smooth() hitTest.hitbox.shape must be 'circle' or 'aabb'");
		}
	}
	if (!hitbox && !hasResolve) {
		throw new Error('[svelte-realtime] live.smooth() hitTest needs a hitbox (declarative) or a resolve function (custom narrowphase)');
	}
	let broadphase;
	if (ht.broadphase !== undefined) {
		if (!ht.broadphase || typeof ht.broadphase !== 'object') {
			throw new Error('[svelte-realtime] live.smooth() hitTest.broadphase must be an object');
		}
		const bpMax = ht.broadphase.maxDist;
		if (bpMax !== undefined && !(typeof bpMax === 'number' && bpMax > 0)) {
			throw new Error('[svelte-realtime] live.smooth() hitTest.broadphase.maxDist must be a positive number');
		}
		const cone = ht.broadphase.cone;
		if (cone !== undefined && !(typeof cone === 'number' && cone >= -1 && cone <= 1)) {
			throw new Error('[svelte-realtime] live.smooth() hitTest.broadphase.cone must be a cosine in [-1, 1]');
		}
		broadphase = { maxDist: bpMax, cone };
	}
	if (ht.position !== undefined && typeof ht.position !== 'function') {
		throw new Error('[svelte-realtime] live.smooth() hitTest.position must be a function (state) => ({ x, y }) | null');
	}
	// The defender-protection cap: the furthest back any shot may rewind, i.e. the
	// worst-case "shot around the corner" a defender can eat. This is the
	// security-critical knob (a latency-faker can at most look like a real player at
	// this latency). Default 100ms is competitive/defender-friendly and suits a ~60Hz
	// topic - it fully compensates good connections (uplink + ~32ms interp) while
	// bounding peeker's advantage to ~one body-width at fast-game speeds. Raise it to
	// favor the shooter / support a high-ping community (the casual default was 1000);
	// it should stay >= one interpolation delay (~2x tickMs) or honest players whose
	// interp buffer alone exceeds the window clamp every shot.
	const maxRewindMs = ht.maxRewindMs === undefined ? 100 : ht.maxRewindMs;
	if (!(typeof maxRewindMs === 'number' && Number.isFinite(maxRewindMs) && maxRewindMs > 0)) {
		throw new Error('[svelte-realtime] live.smooth() hitTest.maxRewindMs must be a positive number');
	}
	if (ht.teleportThreshold !== undefined && !(typeof ht.teleportThreshold === 'number' && ht.teleportThreshold > 0)) {
		throw new Error('[svelte-realtime] live.smooth() hitTest.teleportThreshold must be a positive number');
	}
	if (ht.detectionHook !== undefined && typeof ht.detectionHook !== 'function') {
		throw new Error('[svelte-realtime] live.smooth() hitTest.detectionHook must be a function (info) => ...');
	}
	// Opt-in, off by default. A graded benefit-of-the-doubt for a defender who broke
	// line of sight to the shooter in flight (the "I reached cover but still died"
	// complaint). The framework has positions, not visibility, so the app supplies
	// exposure(shooterState, targetState) => boolean; allowanceMs bounds how far the
	// rewind may be pulled back toward the present for a target that reached cover. It
	// only ever moves resolution toward now (favors the defender), so it can never help
	// a cheating shooter. Sits on top of the maxRewindMs cap, never bypasses it.
	let defenderAllowance;
	if (ht.defenderAllowance !== undefined) {
		const da = ht.defenderAllowance;
		if (da === null || typeof da !== 'object') {
			throw new Error('[svelte-realtime] live.smooth() hitTest.defenderAllowance must be an object { exposure, allowanceMs }');
		}
		if (typeof da.exposure !== 'function') {
			throw new Error('[svelte-realtime] live.smooth() hitTest.defenderAllowance.exposure must be a function (shooterState, targetState) => boolean');
		}
		if (!(typeof da.allowanceMs === 'number' && Number.isFinite(da.allowanceMs) && da.allowanceMs > 0)) {
			throw new Error('[svelte-realtime] live.smooth() hitTest.defenderAllowance.allowanceMs must be a positive number');
		}
		defenderAllowance = { exposure: da.exposure, allowanceMs: da.allowanceMs };
	}
	return {
		hitbox,
		shot: { type: 'ray', origin: shot.origin, dir: shot.dir, maxDist: shot.maxDist },
		onHit: ht.onHit,
		resolve: hasResolve ? ht.resolve : undefined,
		broadphase,
		position: typeof ht.position === 'function' ? ht.position : interest.position,
		maxRewindMs,
		teleportThreshold: ht.teleportThreshold,
		detectionHook: typeof ht.detectionHook === 'function' ? ht.detectionHook : undefined,
		defenderAllowance
	};
}

// Resolve `shot.dir`'s app value into a unit direction. An app may return an
// angle in radians (the common 2D-aim case) or a vector; both normalise here so
// the ray test always gets a unit (dx,dy). A zero or malformed vector yields
// null (the shot is dropped rather than resolved along a degenerate ray).
function _shotUnitDir(d) {
	if (typeof d === 'number') {
		if (!Number.isFinite(d)) return null;
		return { x: Math.cos(d), y: Math.sin(d) };
	}
	if (d !== null && typeof d === 'object' && Number.isFinite(d.x) && Number.isFinite(d.y)) {
		const len = Math.sqrt(d.x * d.x + d.y * d.y);
		if (len === 0) return null;
		return { x: d.x / len, y: d.y / len };
	}
	return null;
}

/**
 * Reconstruct the topic owner's wall clock at a non-owner (the forwarding edge).
 * The owner stamps an absolute `t` on every ack; the edge captures it with its
 * own wall time (`onAck`), so the owner's clock "now" is that stamp plus the
 * wall time elapsed since. Returns null until an ack with a `t` has been seen
 * (cold start) - the edge then forwards no rewind age and the owner resolves the
 * shot at the present (favor the defender). Wall-elapsed (not the monotonic
 * seam) keeps it deterministic under a seeded/faked clock.
 * @param {any} rec
 * @returns {number | null}
 */
function _edgeOwnerNow(rec) {
	if (rec.lastOwnerT === null) return null;
	return rec.lastOwnerT + (wallEpoch() - rec.lastOwnerWall);
}

/**
 * Convert a reach window width + a rewind age (both DURATIONS, milliseconds)
 * into a rewindAt on a ring's own monotonic axis. A null age resolves at the
 * present (favor the defender); otherwise the aimed instant `now - age` is
 * floored by the reach window and capped at the present. This is the age-form of
 * the single-instance clamp `max(now - reach, min(rtMono, now))` and is
 * bit-identical to it for a local shot (where `age = now - rt`).
 * @param {number} nowMono @param {number} reach @param {number | null} rewindAge
 * @returns {number}
 */
export function _smoothRewindAt(nowMono, reach, rewindAge) {
	if (rewindAge === null || rewindAge === undefined) return nowMono;
	return Math.min(nowMono, Math.max(nowMono - reach, nowMono - rewindAge));
}

/**
 * The shoot path's mode-agnostic area-of-interest view: the exact gate radius,
 * the shooter's receipt-time replicated set, the departed-shell broadphase
 * around a rewound point, and the estimated client interpolation delay.
 * Per-client interest answers from its relevancy state. Cells mode answers from
 * the subscription maps: the replicated set is every entity whose current cell
 * the shooter is subscribed to - the transmit gate, since what the client
 * received is exactly cell-scoped - and the broadphase is the cell block around
 * the rewound point widened by one radius, the same 2x-radius recovery shell
 * the per-client broadphase queries (block quantization only ever over-includes,
 * and the exact-radius rewind trim re-applies the final gate). Built once per
 * record when hitTest is on, so the shot handlers never branch on the mode.
 * @param {any} rec
 */
function _smoothAoi(rec) {
	if (rec.cells !== null) {
		const cells = rec.cells;
		return {
			get radius() {
				return cells.radius;
			},
			candidatesFor(identity) {
				const subs = cells.subs.get(identity);
				if (subs === undefined) return undefined;
				const out = [];
				for (const [key, cellKey] of cells.entityCell) {
					if (subs.has(cellKey)) out.push(key);
				}
				return out;
			},
			broadphase(x, y) {
				// 'all' is never a block key, so always-visible entities stay out of
				// the broadphase - a position-based shot cannot hit them (the same
				// exclusion the per-client broadphase applies).
				const block = _cellBlock(cells, x, y, cells.radius);
				const out = [];
				for (const [key, cellKey] of cells.entityCell) {
					if (block.has(cellKey)) out.push(key);
				}
				return out;
			},
			interpDelayMs(identity, seedMs, now) {
				// The cell fan-out has no per-subscriber send walk to measure, and it
				// delivers every changed frame every tick (no LOD cadence), so the
				// dense-path estimate - twice the tick interval, the same cold-start
				// fallback per-client interest uses - IS the cadence the client sees.
				return targetDelayMs(seedMs);
			}
		};
	}
	return {
		get radius() {
			return rec.interest.radius;
		},
		candidatesFor(identity) {
			return rec.interest.getCandidates(identity);
		},
		broadphase(x, y) {
			return rec.interest.candidatesAt(x, y, rec.interest.radius * 2);
		},
		interpDelayMs(identity, seedMs, now) {
			return rec.interest.interpDelayMs(identity, seedMs, now);
		}
	};
}

/**
 * The server world view handed to `onTick`: a scoped authority surface for
 * server game logic (forces, deaths, respawns, scripted movers, NPCs). Built
 * once per record when `onTick` is configured; `run` binds it to one tick's
 * drain result, invokes the hook, and reports what it did so the tick can
 * publish and re-arm. The hook runs post-drain, so reads see the tick's
 * settled states, and every write lands in the SAME tick's broadcast (merged
 * into `updates`, with a pending ack fixed up to keep carrying the final
 * state - the invariant inject established) and in the catalog the rings and
 * relevancy consume below the hook.
 * @param {any} rec
 */
function _smoothWorld(rec) {
	// One sentinel per record: the `ws` slot for server entities. The authority
	// compares ws by reference, so re-ensuring a server key never resets it; no
	// close path ever matches the sentinel, so a server entity lives until
	// world.remove - the deliberate lifecycle (it also keeps its record alive).
	const sentinel = { __smoothServer: true };
	let updates = null;
	let acks = null;
	let dirty = false;
	let armed = false;
	// Merge one changed entity into THIS tick's updates: overwrite the drain's
	// entry when the entity already moved this tick (one frame, final state),
	// else append a non-commanded update (the owner must receive it - the same
	// polarity onMissing/inject delivery holds). A pending ack for the entity is
	// updated to the final state so the owner reconciles in one step.
	function report(key, state, ws) {
		let found = false;
		for (let i = 0; i < updates.length; i++) {
			if (updates[i].key === key) {
				updates[i] = { key, state, ws: updates[i].ws, commanded: false };
				found = true;
				break;
			}
		}
		if (!found) updates.push({ key, state, ws, commanded: false });
		for (let i = 0; i < acks.length; i++) {
			if (acks[i].key === key) {
				acks[i].state = state;
				break;
			}
		}
		dirty = true;
	}
	const world = {
		/** The resolved topic name this world belongs to. One onTick serves
		 * every room of its topic family; this is the key that keeps each
		 * room's server-side state (a bullet world, a match clock) apart. */
		get topic() {
			return rec.name;
		},
		/** The entity's authoritative state, or undefined. A read-only value:
		 * assigning into it does not (and must not) reach the authority - use set. */
		get(key) {
			const e = rec.authority.get(key);
			return e === undefined ? undefined : e.state;
		},
		/** Every entity's `{ key, state }`, the post-drain snapshot. */
		catalog() {
			return rec.authority.catalog();
		},
		/**
		 * REPLACE an entity's state (teleport, respawn, scripted placement):
		 * broadcasts this tick, wakes onMissing. False for an unknown key.
		 */
		set(key, state) {
			const e = rec.authority.get(key);
			if (e === undefined) return false;
			rec.authority.set(key, state);
			report(key, state, e.ws);
			return true;
		},
		/**
		 * Run a command through the shared `apply` (a knockback impulse, damage) -
		 * the same name and semantics as the shoot ctx's applyTo. Applies on the
		 * NEXT tick (commands land on drains), which the hook's return arms.
		 */
		applyTo(key, cmd) {
			if (typeof key !== 'string') return false;
			if (rec.authority.inject(key, cmd)) {
				armed = true;
				return true;
			}
			return false;
		},
		/**
		 * Create a SERVER entity (no connection): starts active, so onMissing
		 * drives it from its first tick; broadcasts its spawn this tick. An
		 * omitted initialState seeds through the warm-handoff-aware path (a
		 * snapshot-recovered state, else the declared `initial(key)`). For an
		 * EXISTING key this is a read - it never rebinds (rebinding a client
		 * entity to the server sentinel would steal its command stream, so a
		 * collision warns once in dev: give server entities their own key
		 * namespace, e.g. a prefix).
		 */
		ensure(key, initialState) {
			const existing = rec.authority.get(key);
			if (existing !== undefined) {
				if (_IS_DEV && existing.ws !== sentinel && !rec.worldEnsureWarned) {
					rec.worldEnsureWarned = true;
					console.warn(
						'[svelte-realtime] live.smooth() onTick world.ensure(' + JSON.stringify(key) + ') targets an entity owned by a live connection; ' +
						'server entities should use their own key namespace (e.g. a prefix). The call is a no-op read.'
					);
				}
				return existing.state;
			}
			const state = initialState !== undefined ? initialState : _smoothSeed(rec, key);
			rec.authority.ensure(key, sentinel, state, { active: true });
			report(key, state, sentinel);
			return state;
		},
		/**
		 * Remove an entity with the full departure bundle every removal site
		 * holds: authority drop, ring drop, registry/interest/cells release, and
		 * the departure broadcast (cell-scoped in cells mode, cluster-relayed).
		 */
		remove(key) {
			if (rec.authority.get(key) === undefined) return false;
			for (let i = 0; i < updates.length; i++) {
				if (updates[i].key === key) {
					updates.splice(i, 1);
					break;
				}
			}
			rec.authority.remove(key);
			if (rec.interest) {
				rec.registry.delete(key);
				rec.interest.releaseSubscriber(key);
			}
			if (rec.cells) {
				rec.registry.delete(key);
				_releaseCellSubs(rec, key);
			}
			_smoothRelayRemove(rec, key);
			dirty = true;
			return true;
		}
	};
	return {
		/**
		 * Bind the view to this tick's drain result and run the hook. Returns
		 * `{ dirty, rearm }`: `dirty` = state actually changed this tick (counts
		 * as live motion for the hitTest grace window); `rearm` = the next tick
		 * must fire (a mutation, a pending injection, or the hook returning true -
		 * the explicit heartbeat for time-based logic like respawn timers).
		 */
		run(tickUpdates, tickAcks, t) {
			updates = tickUpdates;
			acks = tickAcks;
			dirty = false;
			armed = false;
			let more = false;
			try {
				more = rec.cfg.onTick(world, t) === true;
			} catch (err) {
				// App logic riding the framework tick: a throw must never kill the
				// tick (the drain's own updates still publish). Surface it once per
				// record in dev rather than swallowing silently.
				if (_IS_DEV && !rec.worldThrowWarned) {
					rec.worldThrowWarned = true;
					console.warn('[svelte-realtime] live.smooth() onTick threw; the tick continues without its remaining changes.', err);
				}
			}
			const result = { dirty, rearm: dirty || armed || more };
			updates = null;
			acks = null;
			return result;
		}
	};
}

/**
 * Edge measurement for a shot: from the shot payload compute the favor-shooter
 * reach WIDTH and the rewind AGE (both durations, axis-free), run the per-
 * connection replay defense + latch, and - when a `detectionHook` is configured
 * - the latency detection picture. `now` is the wall time on the OWNER's axis:
 * `wallEpoch()` on the owner / single instance, the reconstructed owner clock on
 * a forwarding edge (null on edge cold start -> resolve at present). Both the
 * uplink sample and the replay latch live on this connection's `ws` (the edge
 * always holds the real shooter socket, so the WeakMap already keys on the
 * origin client, never the inter-instance hop). Returns the forwarded payload
 * shape `{ cmd, reach, rewindAge, detect, nowMono }`, or null when the shot is a
 * replayed / older render-time the latch rejects.
 * @param {any} rec @param {any} ctx @param {any} payload @param {string} shooterKey @param {number | null} now
 * @returns {{ cmd: any, reach: number, rewindAge: number | null, detect: any, nowMono: number | null } | null}
 */
export function _smoothEdgeMeasure(rec, ctx, payload, shooterKey, now) {
	const ht = rec.cfg.hitTest;
	const cmd = payload.cmd;
	// No owner-clock basis yet (edge cold start): forward at the present.
	if (now === null) return { cmd, reach: ht.maxRewindMs, rewindAge: null, detect: null, nowMono: null };
	const nowMono = rec.monoClock.mono(now);
	const monoCorr = nowMono - now;
	const rtStamp = payload.rt;
	let reach = ht.maxRewindMs;
	let rewindAge = null;
	let detect = null;
	if (typeof rtStamp === 'number' && Number.isFinite(rtStamp)) {
		let st = ctx.ws ? _lcRtt.get(ctx.ws) : undefined;
		if (ctx.ws && st === undefined) {
			st = { tracker: createRttTracker(), lastRt: -Infinity };
			_lcRtt.set(ctx.ws, st);
		}
		// Map the wall-axis render-time onto the monotonic axis so the replay
		// defense, the latch, and the age all live on one axis (a wall backstep
		// then stays continuous). monoCorr is zero in normal operation.
		const rtMono = rtStamp + monoCorr;
		// Replay defense: a real rendered instant only advances, so a render-time
		// strictly OLDER than the last accepted one (a captured shot resent to
		// re-resolve an old lineup) is dropped before it can resolve or forward.
		if (st && rtMono < st.lastRt) return null;
		const ackT = payload.ackT;
		if (st && typeof ackT === 'number' && Number.isFinite(ackT) && ackT <= now && now - ackT <= ht.maxRewindMs) {
			st.tracker.sample((now - ackT) / 2, nowMono);
		}
		// Favor-the-shooter reach width = measured uplink (max-of-recent) + the
		// client's interpolation delay; both server-measured, clamped to the cap.
		// The interpolation seed is the WIRE interval (tickMs widened by the
		// broadcast gate) - the client renders behind the cadence it receives.
		const maxUp = st ? st.tracker.maxUplink() : null;
		const serverInterp = rec.aoi.interpDelayMs(shooterKey, rec.tickMs * rec.broadcastEvery, now);
		reach = maxUp === null ? ht.maxRewindMs : Math.min(ht.maxRewindMs, maxUp + serverInterp);
		// The rewind age is a pure duration the owner applies to its own present.
		rewindAge = Math.max(0, now - rtStamp);
		if (st) st.lastRt = Math.max(st.lastRt, Math.min(rtMono, nowMono));
		if (ht.detectionHook !== undefined && st) {
			const minUp = st.tracker.minUplink();
			detect = {
				minUplink: minUp,
				maxUplink: maxUp,
				reach,
				interpDelay: serverInterp,
				divergence: minUp !== null && maxUp !== null ? maxUp - minUp : 0
			};
		}
	}
	return { cmd, reach, rewindAge, detect, nowMono };
}

/**
 * Resolve a shot against the rewound world: gate candidates at `rewindAt`, run
 * the shot geometry from the shooter's CURRENT state, the broadphase + per-
 * candidate narrowphase, the nearest-first `onHit` consequence, and the hit-
 * event broadcast (plus cluster relay). Shared by the local / owner-direct shot
 * path and the forwarded-shot owner handler; the caller computes `rewindAt`
 * (directly from a local measurement, or from forwarded durations on the owner)
 * and supplies the platform whose `smooth` coordinator relays the hit events.
 * @param {any} rec @param {string} name @param {string} shooterKey
 * @param {any} shooterEntity @param {any} ctxPlatform @param {any} cmd @param {number} rewindAt @param {number} nowMono
 */
export async function _smoothResolveShot(rec, name, shooterKey, shooterEntity, ctxPlatform, cmd, rewindAt, nowMono) {
	const ht = rec.cfg.hitTest;
	const cluster = ctxPlatform && ctxPlatform.smooth;
	// Candidate set, gated at the REWIND instant rather than at receipt: a target
	// the shooter had on screen when it fired is a valid hit even if it drifted
	// out of range in flight, and one that drifted in only after firing is not.
	// `rec.aoi` resolves the receipt-time set / broadphase / radius from whichever
	// interest mode the topic runs (per-client relevancy or cell subscription).
	const candKeys = new Set();
	const liveCand = rec.aoi.candidatesFor(shooterKey);
	if (liveCand !== undefined) for (const k of liveCand) if (k !== shooterKey) candKeys.add(k);
	// The geometric gate compares ring positions against the interest radius, so
	// it is only sound when the ring records the SAME position the interest set
	// uses (the default, where hitTest.position falls back to interest.position).
	// A custom hitTest.position in another space, or a null rewound center, skips
	// the gate and falls back to the receipt-time membership.
	const gateInRingSpace = rec.cfg.hitTest.position === rec.cfg.interest.position;
	const shooterAt = gateInRingSpace ? rec.lagComp.sample(shooterKey, rewindAt) : null;
	let world;
	if (shooterAt === null) {
		if (candKeys.size === 0) return;
		world = rec.lagComp.rewind(candKeys, rewindAt);
	} else {
		const radius = rec.aoi.radius;
		// Also broadphase the departed shell - entities near the shooter's rewound
		// position the receipt-time set no longer lists (they left in flight). The
		// exact gate below trims it back, so over-pulling is safe.
		const near = rec.aoi.broadphase(shooterAt.x, shooterAt.y);
		for (let i = 0; i < near.length; i++) if (near[i] !== shooterKey) candKeys.add(near[i]);
		if (candKeys.size === 0) return;
		world = rec.lagComp.rewindWithin(candKeys, rewindAt, shooterAt.x, shooterAt.y, radius * radius);
	}
	if (world.size === 0) return;
	// defenderAllowance (opt-in, off by default): a graded benefit-of-the-doubt for a
	// defender that broke line of sight to the shooter in flight. The app owns occlusion
	// via exposure(shooterState, targetState) (the framework has positions, not visibility).
	// A candidate visible to the shooter at the rewind instant but occluded by biasedAt =
	// min(now, rewindAt + allowanceMs) reached cover within the allowance window and is
	// DROPPED from the candidate set - it cannot be hit by this shot. Dropping (rather than
	// relocating the candidate to its later position) keeps the grace STRICTLY SUBTRACTIVE:
	// it can only ever turn a hit into a miss, never a miss into a hit, so it can never help
	// the shooter regardless of how the app's occlusion relates to the shot ray geometry. A
	// throwing/slow exposure hook fails safe to no grace (never the shot). Bounded by
	// allowanceMs, so it only relaxes the maxRewindMs cap toward the present, never past it.
	const da = ht.defenderAllowance;
	if (da !== undefined && nowMono !== null) {
		const biasedAt = Math.min(nowMono, rewindAt + da.allowanceMs);
		if (biasedAt > rewindAt) {
			const maybeGrace = new Set();
			for (const [key, s] of world) {
				let visThen;
				try { visThen = da.exposure(shooterEntity.state, s.state); } catch { continue; }
				if (visThen) maybeGrace.add(key);
			}
			if (maybeGrace.size > 0) {
				const later = rec.lagComp.rewind(maybeGrace, biasedAt);
				for (const key of maybeGrace) {
					const ls = later.get(key);
					if (ls === undefined) continue;
					let visLater;
					try { visLater = da.exposure(shooterEntity.state, ls.state); } catch { continue; }
					if (visLater) continue;
					world.delete(key);
				}
			}
		}
	}
	// Shot geometry from the shooter's CURRENT state: only the targets rewind. A
	// throw on malformed state drops the shot (favor-defender miss).
	let origin, dir;
	try {
		origin = ht.shot.origin(cmd, shooterEntity.state);
		dir = _shotUnitDir(ht.shot.dir(cmd, shooterEntity.state));
	} catch {
		return;
	}
	if (origin === null || typeof origin !== 'object' || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return;
	if (dir === null) return;
	const maxDist = ht.shot.maxDist;
	const useResolve = typeof ht.resolve === 'function';
	// Broadphase distance cull, defaulting to maxDist plus the hitbox's own reach
	// so a target centred just past maxDist can still be struck on its near edge.
	const hitboxReach = useResolve
		? Infinity
		: ht.hitbox.shape === 'circle'
			? ht.hitbox.radius
			: 0.5 * Math.sqrt(ht.hitbox.w * ht.hitbox.w + ht.hitbox.h * ht.hitbox.h);
	const bpMaxDist = ht.broadphase && ht.broadphase.maxDist ? ht.broadphase.maxDist : maxDist + hitboxReach;
	const bpMaxSq = bpMaxDist * bpMaxDist;
	const cone = ht.broadphase ? ht.broadphase.cone : undefined;
	const shot = { origin, dir, maxDist };
	// The shoot ctx is per-shot (not per-target): applyTo (authoritative cross-
	// entity mutation) and emitEvent (the hit signal) are plain locals.
	let armed = false;
	const pendingEvents = [];
	const shootCtx = {
		identity: shooterKey,
		platform: ctxPlatform,
		applyTo(victimKey, victimCmd) {
			if (typeof victimKey !== 'string') return false;
			if (rec.authority.inject(victimKey, victimCmd)) {
				armed = true;
				return true;
			}
			return false;
		},
		emitEvent(type, data, opts) {
			if (typeof type !== 'string') return;
			pendingEvents.push({ type, data, opts });
		}
	};
	// Broadphase cull + narrowphase per candidate, nearest-first. Penetration is
	// ON by default: every aligned candidate is hit unless onHit returns { stop: true }.
	const hits = [];
	for (const [key, s] of world) {
		const vx = s.x - origin.x;
		const vy = s.y - origin.y;
		const distSq = vx * vx + vy * vy;
		if (distSq > bpMaxSq) continue;
		if (cone !== undefined && cone !== null && distSq > 0) {
			if ((vx * dir.x + vy * dir.y) / Math.sqrt(distSq) < cone) continue;
		}
		let hit;
		if (useResolve) {
			hit = ht.resolve(shot, { key, pos: { x: s.x, y: s.y }, state: s.state }, shootCtx);
		} else if (ht.hitbox.shape === 'circle') {
			hit = rayCircleHit(origin.x, origin.y, dir.x, dir.y, maxDist, s.x, s.y, ht.hitbox.radius);
		} else {
			hit = rayAabbHit(origin.x, origin.y, dir.x, dir.y, maxDist, s.x, s.y, ht.hitbox.w, ht.hitbox.h);
		}
		if (hit !== null && hit !== undefined && Number.isFinite(hit.dist)) {
			hits.push({ key, pos: { x: s.x, y: s.y }, state: s.state, dist: hit.dist, point: hit.point, fallback: s.fallback });
		}
	}
	if (hits.length === 0) return;
	hits.sort((a, b) => a.dist - b.dist);
	for (let i = 0; i < hits.length; i++) {
		const h = hits[i];
		const target = { key: h.key, pos: h.pos, state: h.state };
		const info = { dist: h.dist, point: h.point, fraction: maxDist > 0 ? h.dist / maxDist : 0, rewindAt, fallback: h.fallback };
		const verdict = await ht.onHit(shootCtx, target, info);
		if (verdict && verdict.stop) break;
	}
	// onHit may have awaited; if the topic was forgotten or this instance lost
	// ownership meanwhile, do not publish the events or arm a dead/demoted record.
	if (_smoothTopics.get(name) !== rec || (cluster && !rec.owned)) return;
	for (let i = 0; i < pendingEvents.length; i++) {
		const pe = pendingEvents[i];
		const wire = {
			type: pe.type,
			key: pe.opts && typeof pe.opts.key === 'string' ? pe.opts.key : shooterKey,
			data: pe.data,
			id: ++rec.shootEventSeq
		};
		_smoothPublish(rec, 'event', wire, undefined);
		if (cluster && typeof cluster.relayBroadcast === 'function') {
			cluster.relayBroadcast(rec.wireTopic, 'event', wire, undefined, rec.eventSeq++);
		}
	}
	if (armed) _armSmoothTick(rec);
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
 * `tickMs?` (authoritative tick interval, default 50), `broadcastHz?` (wire
 * broadcast rate: entity updates are sent every Nth tick - N derived from
 * tickMs - instead of every tick, with the motion of skipped ticks coalesced
 * into the next frame (an entity's CURRENT state, never a stale one) and the
 * client interpolation covering the widened gap. Acknowledgements, discrete
 * events, and removals stay per-tick, so the owner's reconciliation and
 * one-shot actions never lag. The final rest state always flushes when motion
 * stops. Default: broadcast every tick, byte-identical), `noEcho?` (suppress
 * echoing an owner's own commanded updates in broadcasts, default true - the
 * acknowledgement carries the owner's copy; onMissing motion has no
 * acknowledgement and always broadcasts to the owner too), `queueCap?`
 * (per-entity command queue bound), `snapshot?` (opt-in warm handoff: when
 * true, the topic owner persists a debounced state snapshot so a cluster
 * failover resumes entities from their last state (which must be JSON-
 * serializable, the same constraint the sync reply already relays) instead of `initial`;
 * cluster-only - it needs `platform.smooth` - and default false, so the
 * single-instance path is unchanged), `snapshotDebounceMs?` (snapshot write
 * throttle, default 1000), `topicArgs?` (explicit room-arg count
 * when the topic function's arity cannot express it), `interest?` (opt-in
 * area-of-interest culling for an uncapped lobby: each subscriber is delivered
 * only the entity updates inside its area of interest, near entities every tick
 * and fringe entities at a throttled cadence. `interest.radius` (required, the
 * cull radius in the app's position units) and `interest.position(state) =>
 * ({x,y}) | null` (required; null means always-visible) drive the cull; the
 * area-of-interest center is the subscriber's own entity by default. Optional
 * `interest.lod` is an ascending list of `{ within, rate }` level-of-detail
 * bands (send every `rate` ticks within that distance; the outer band's edge is
 * the cull radius), `interest.cell` tunes the spatial grid, and
 * `interest.budget` caps how many entities are delivered to one subscriber per
 * tick: past the ceiling the due set trims farthest-first (fringe bands demote
 * before the action around the player), a trimmed entity stays due and delivers
 * as soon as the budget frees, and the ceiling scales down automatically for a
 * subscriber whose socket is backpressured - congestion sheds the fringe
 * smoothly instead of letting the transport drop arbitrary frames. Per-client
 * interest mode only (with `cells` it throws). `interest.cells` switches to
 * population-scale cell-topic mode: area-of-interest becomes SUBSCRIPTION to
 * grid-cell topics (one encode per cell, native fan-out) instead of a
 * per-subscriber cull. `interest.centerPolicy` gates reported centers
 * ('any' default = ungated; 'own-entity' clamps positioned-entity owners to
 * their entity; a callback decides per report). Default off, so the
 * broadcast-all path is byte-identical), `wire?` (the topic's wire views:
 * app-owned codec pairs applied at the CLIENT wire boundary and nowhere else.
 * `wire.state = { pack, unpack }` packs every state the clients receive -
 * updates, acknowledgements, the sync roster - into a compact JSON-serializable
 * form, so a rich simulation state stops paying verbose-JSON prices per tick;
 * `wire.command = { pack, unpack }` is the inverse for inbound commands and
 * shots, unpacked at the RPC entry (a malformed packed command is dropped,
 * never applied). Everything internal - the authority, lag compensation,
 * interest culling, the cluster relay and shadow catalog, the warm-handoff
 * snapshot - runs on the full state; each instance packs independently at its
 * own client edge. The client channel must declare the SAME pairs (share the
 * module, like `apply`; requires svelte-adapter-uws >= 0.6.0-next.49 for the
 * client-side unpack). Default off, byte-identical wire).
 *
 * @param {{ topic: string | Function, apply: Function, initial: any, guard?: Function, onMissing?: Function, tickMs?: number, broadcastHz?: number, noEcho?: boolean, queueCap?: number, snapshot?: boolean, snapshotDebounceMs?: number, topicArgs?: number, interest?: { radius: number, position: (state: any) => ({ x: number, y: number } | null), lod?: Array<{ within: number, rate: number }>, cell?: number, budget?: number }, wire?: { state?: { pack: (state: any) => any, unpack: (packed: any) => any }, command?: { pack: (cmd: any) => any, unpack: (packed: any) => any } } }} config
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
	if (config.broadcastHz !== undefined && !(typeof config.broadcastHz === 'number' && Number.isFinite(config.broadcastHz) && config.broadcastHz > 0)) {
		throw new Error('[svelte-realtime] live.smooth() broadcastHz must be a positive number');
	}
	if (config.queueCap !== undefined && !(typeof config.queueCap === 'number' && Number.isInteger(config.queueCap) && config.queueCap >= 1)) {
		throw new Error('[svelte-realtime] live.smooth() queueCap must be an integer of at least 1');
	}
	if (config.snapshot !== undefined && typeof config.snapshot !== 'boolean') {
		throw new Error('[svelte-realtime] live.smooth() snapshot must be a boolean');
	}
	const snapshotDebounceMs = config.snapshotDebounceMs === undefined ? _SMOOTH_SNAPSHOT_MS : config.snapshotDebounceMs;
	if (!(typeof snapshotDebounceMs === 'number' && Number.isFinite(snapshotDebounceMs) && snapshotDebounceMs > 0)) {
		throw new Error('[svelte-realtime] live.smooth() snapshotDebounceMs must be a positive number');
	}
	if (config.onTick !== undefined && typeof config.onTick !== 'function') {
		throw new Error('[svelte-realtime] live.smooth() onTick must be a function (world, t) => void | boolean\n  See: https://svti.me/smooth');
	}
	const wire = config.wire === undefined ? undefined : _validateWire(config.wire);
	const interest = config.interest === undefined ? undefined : _validateInterest(config.interest);
	const hitTest = config.hitTest === undefined ? undefined : _validateHitTest(config.hitTest, interest);
	const cfg = {
		apply: config.apply,
		initial: config.initial,
		onMissing: config.onMissing,
		queueCap: config.queueCap,
		tickMs,
		broadcastHz: config.broadcastHz,
		noEcho: config.noEcho !== false,
		snapshot: config.snapshot === true,
		snapshotDebounceMs,
		interest,
		hitTest,
		onTick: config.onTick,
		wire
	};
	const guard = config.guard;
	const argCount = config.topicArgs !== undefined
		? config.topicArgs
		: (typeof topicFn === 'function' ? Math.max(0, topicFn.length - 1) : 0);

	// Prefix the resolved name ONCE with the connection's tenant: the wire topic
	// (SMOOTH_TOPIC_PREFIX + name), the `_smoothTopics` map key, the cluster relay
	// channel, and the reverse `_smoothRecByWire` lookup all derive from `name`, so
	// scoping it here isolates an entire smooth entity per tenant. Null tenant ->
	// unchanged (byte-identical single-tenant path).
	const resolveName = (ctx, roomArgs) =>
		_tenantTopic(ctx.tenantId, typeof topicFn === 'function' ? _callTopicFn(topicFn, ctx, roomArgs) : topicFn);

	const smoothExport = /** @type {any} */ ({});
	smoothExport.__isSmooth = true;
	// The normalized, validated config. The deterministic-netcode sim reads it to
	// build a faithful record through the same `_smoothRecord` the handlers use,
	// without re-validating. Set once at declaration time (not per tick or
	// connection), so the hot path is unaffected.
	smoothExport.__smoothCfg = cfg;

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
		// Re-sync flood cutoff, AFTER admission (a denied subscribe must not be
		// able to consume anyone's allowance) and before any O(catalog) work. The
		// reply carries the whole roster, so an unthrottled stream of ~60-byte
		// sync frames is a large work-per-byte asymmetry against a populated
		// topic; a real client syncs on join and on reconnect, never in a stream.
		// Liveness re-check FIRST: if the socket closed while the guard / runtime
		// load / subscribe was pending, the close drain has already run, and
		// ensuring now would create a ghost entity bound to a freed handle (or
		// steal ownership from a live tab). It also has to precede the allowance
		// bookkeeping below - the drain for this socket is already done, so an
		// entry minted after it would be orphaned in `rec.syncRate` forever, one
		// per attacker socket, keyed by a guest id nothing can re-derive.
		if (ctx.ws && _smoothClosedWs.has(ctx.ws)) {
			if (rec.authority.size === 0 && rec.timer === null) _smoothForget(rec);
			throw new LiveError('CONNECTION_CLOSED', 'WebSocket closed during smooth sync');
		}
		if (!_smoothSyncAdmit(rec, _getIdentityKey(ctx))) {
			throw new LiveError(
				'RATE_LIMITED',
				'smooth re-sync rate exceeded (max ' + _SMOOTH_SYNC_MAX_PER_WINDOW + ' per ' +
				_SMOOTH_RESYNC_WINDOW_MS + 'ms per identity); back off and retry'
			);
		}
		const key = _getIdentityKey(ctx);
		const cluster = ctx.platform && ctx.platform.smooth;
		if (cluster) {
			// Register this socket as the topic's local subscriber for `key` (the
			// ack-routing and author-exclusion paths read this), wire the relay
			// handlers once, then race the ownership lease against the subscribe
			// above.
			if (ctx.ws) rec.registry.set(key, ctx.ws);
			_ensureSmoothCluster(cluster);
			// On a Redis failure, degrade to a local authority (owned=true) so the
			// client keeps a working entity rather than a frozen one. Deliberate
			// availability tradeoff: during a sustained outage the coordinator's
			// breaker opens and outbound relays no-op, so each instance runs
			// isolated (no cross-instance traffic, no cross-owner event double-fire);
			// only the brief pre-breaker window can relay from two pseudo-owners,
			// which the per-owner seq dedup does not cover - an outage-only artifact.
			const wasOwned = rec.owned;
			let owned = true;
			try {
				owned = await cluster.acquireOwner(rec.wireTopic);
			} catch {
				owned = true;
			}
			// A demotion observed on this path (we held the tick, the lease is gone)
			// drops this tenure's warm-handoff state so a later re-acquire reads the
			// snapshot fresh rather than reusing a stale pending set. (A rare Redis
			// lease flap landing between two concurrent same-instance syncs could let
			// this clear wipe the other sync's just-loaded pending; the only effect is
			// that topic's entities fall back to `initial` - the snapshot-off default -
			// for that one handoff, never an incorrect state, a leak, or a hang.)
			if (wasOwned && !owned) _smoothClearSnapshotState(rec);
			if (owned && rec.cfg.snapshot) {
				// Warm handoff (opt-in): a fresh owner LOADS the snapshot the previous
				// owner persisted BEFORE it publishes ownership, so neither a concurrent
				// sync nor a relay handler (both gated on `rec.owned`) can seed an entity
				// from `initial` while the read is still in flight. Loaded once per
				// tenure into `pendingSnapshot` behind a shared barrier promise; each
				// entity is then seeded the moment its real client re-binds
				// (`_smoothSeed`), so a client that never returns never enters the
				// authority. Its recovered state waits in `pendingSnapshot`, re-persisted
				// on write (a second failover still recovers it) and grace-dropped on
				// the tick (the cache stays bounded).
				await _smoothLoadSnapshot(rec, cluster);
			}
			// Publish ownership AFTER the snapshot is ready (so the relay seed sites
			// see a populated `pendingSnapshot`) but BEFORE the liveness re-check, so a
			// socket that closed during either await releases the lease via
			// _smoothForget rather than leaking it until the TTL.
			rec.owned = owned;
			// Became the ticking owner: the authoritative catalog supersedes any
			// receive-side shadow built while this instance was a non-owner, so drop it
			// (a later demotion rebuilds it from inbound relays). No-op when this
			// instance was already the owner or interest is off (the maps stay empty).
			if (owned && (rec.shadow.size > 0 || rec.pendingRelay.size > 0)) {
				rec.shadow.clear();
				rec.pendingRelay.clear();
				rec.shadowDirty = false;
			}
			if (ctx.ws && _smoothClosedWs.has(ctx.ws)) {
				rec.registry.delete(key);
				if (rec.authority.size === 0 && rec.registry.size === 0 && rec.timer === null) _smoothForget(rec);
				throw new LiveError('CONNECTION_CLOSED', 'WebSocket closed during smooth sync');
			}
			if (owned) {
				// This instance ticks the topic: ensure the entity against the real
				// socket (seeded from the snapshot when one was recovered, else the
				// declared initial - identical to single-instance when snapshot is off).
				const ensured = rec.authority.ensure(key, ctx.ws, _smoothSeed(rec, key));
				// Cells mode: place the joiner's cell block now (from its just-ensured
				// entity, or a retained reported center) - without this an owner-local
				// joiner received nothing until its entity first moved.
				if (rec.cells && ctx.ws) _placeCellSubscriber(rec, key, ctx.ws);
				// A server-driven topic (onTick) exists only because the tick runs, so a
				// client that subscribes and watches without sending a command first must
				// still start the tick - otherwise it sees zero server entities. Idempotent
				// (a pending timer is a no-op) and gated on an onTick world so non-onTick
				// topics stay byte-identical (they legitimately arm on the first command).
				if (rec.world !== null) _armSmoothTick(rec);
				return { topic: name, t: wallEpoch(), you: key, ack: ensured.lastAckedId, states: _smoothSyncRoster(rec, key), ...(rec.lagComp !== null && { lc: 1 }), ...(rec.cells && { cells: 1 }) };
			}
			// Non-owner: ask the owner for the catalog. On a timeout, return a
			// local-empty basis - incoming broadcasts reconcile the client.
			const corr = cluster.instanceId + ':' + (++_smoothCorrSeq);
			const reply = await _smoothRequestSync(rec, cluster, key, corr);
			if (ctx.ws && _smoothClosedWs.has(ctx.ws)) {
				rec.registry.delete(key);
				if (rec.authority.size === 0 && rec.registry.size === 0 && rec.timer === null) _smoothForget(rec);
				throw new LiveError('CONNECTION_CLOSED', 'WebSocket closed during smooth sync');
			}
			// Seed the receive-side shadow catalog from the owner's snapshot so the cull
			// can deliver a stationary in-range remote entity on first sight (an entity
			// that has not moved since this client joined sends no relay frame, so without
			// the seed it would be invisible - an under-delivery). The full snapshot is
			// still returned to the joining client below (a safe over-deliver on join);
			// only the ongoing relayed deltas are culled.
			if (rec.interest !== null && reply && Array.isArray(reply.states)) {
				for (let i = 0; i < reply.states.length; i++) rec.shadow.set(reply.states[i].key, reply.states[i].state);
			}
			// Cells mode on a non-owner: the local authority is empty, so place the
			// joiner's cell block from its own entry in the owner's reply (recorded
			// into lastPos by the follow), and scope the client-facing roster to its
			// cell block - the owner's reply is deliberately the FULL catalog (it is
			// also the own-position source here), but the client gets O(block).
			let states = reply && Array.isArray(reply.states) ? reply.states : [];
			if (rec.cells) {
				if (ctx.ws) {
					const ownEntry = states.find((s) => s && s.key === key);
					if (ownEntry !== undefined) _smoothCellFollow(rec, key, ctx.ws, ownEntry.state);
					else _placeCellSubscriber(rec, key, ctx.ws); // a reported center / lastPos fallback
				}
				states = _smoothCellSnapshot(rec, key, states);
			}
			return {
				topic: name,
				t: wallEpoch(),
				you: key,
				ack: reply ? reply.ack : 0,
				states: _smoothWireStates(rec, states),
				...(rec.lagComp !== null && { lc: 1 }),
				...(rec.cells && { cells: 1 })
			};
		}
		const ensured = rec.authority.ensure(key, ctx.ws, _smoothResolveInitial(cfg, key));
		// Interest topics need the identity -> socket map even single-instance (the
		// cluster path keeps it for ack routing; interest reuses it as the
		// per-subscriber relevancy and delivery set; cells mode reuses it to follow a
		// subscriber's own entity for its cell block). No awaits follow, so the
		// liveness re-check above still holds.
		if ((rec.interest || rec.cells) && ctx.ws) rec.registry.set(key, ctx.ws);
		// Cells mode: place the joiner's cell subscription block from its own entity's
		// initial position now, so it starts receiving nearby cells immediately (the
		// full catalog below is the safe over-deliver on join; ongoing deltas are
		// cell-scoped).
		if (rec.cells && ctx.ws) _placeCellSubscriber(rec, key, ctx.ws);
		// A server-driven topic (onTick) exists only because the tick runs, so a
		// client that subscribes and watches without sending a command first must
		// still start the tick - otherwise it sees zero server entities. Idempotent
		// (a pending timer is a no-op) and gated on an onTick world so non-onTick
		// topics stay byte-identical (they legitimately arm on the first command).
		if (rec.world !== null) _armSmoothTick(rec);
		return {
			topic: name,
			t: wallEpoch(),
			you: key,
			ack: ensured.lastAckedId,
			// Interest on (either mode): scope the join snapshot to the joiner's
			// area of interest (the roster fanout is O(n^2) if every joiner gets
			// the whole board). Broadcast path: the full catalog, unchanged.
			states: _smoothSyncRoster(rec, key),
			...(rec.lagComp !== null && { lc: 1 }),
			...(rec.cells && { cells: 1 })
		};
	});

	smoothExport.__smoothCommand = live.volatile(async (ctx, ...args) => {
		const roomArgs = args.slice(0, argCount);
		if (guard) await guard(ctx, ...roomArgs);
		let batch = args[argCount];
		if (!Array.isArray(batch) || batch.length === 0) return;
		// Wire view: commands arrive packed; unpack at the entry so everything
		// downstream - the local enqueue AND the cross-node forward - runs on
		// the full command. A malformed entry is dropped, never applied.
		const wireCmd = cfg.wire !== undefined ? cfg.wire.command : undefined;
		if (wireCmd !== undefined) {
			const unpacked = [];
			for (let i = 0; i < batch.length; i++) {
				const c = batch[i];
				if (c === null || typeof c !== 'object' || typeof c.id !== 'number') continue;
				try {
					unpacked.push({ id: c.id, cmd: wireCmd.unpack(c.cmd) });
				} catch {
					/* malformed packed command: drop the entry */
				}
			}
			if (unpacked.length === 0) return;
			batch = unpacked;
		}
		const name = resolveName(ctx, roomArgs);
		const rt = await _loadSmoothRuntime();
		// Liveness re-check after the awaits: a command from a socket whose
		// close drain already ran must not re-create its entity. Volatile
		// path, so bail silently - there is no reply to error.
		if (ctx.ws && _smoothClosedWs.has(ctx.ws)) return;
		const rec = _smoothRecord(name, cfg, ctx.platform, rt);
		const key = _getIdentityKey(ctx);
		const cluster = ctx.platform && ctx.platform.smooth;
		if (cluster && !rec.owned) {
			// Non-owner: forward the batch to the topic's owner as one envelope
			// (fire-and-forget; the owner drops already-acked ids and ticks).
			if (typeof cluster.relayCommand === 'function') {
				cluster.relayCommand(rec.wireTopic, key, cluster.instanceId, batch);
			}
			return;
		}
		const existing = rec.authority.get(key);
		if (existing === undefined) {
			rec.authority.ensure(key, ctx.ws, _smoothSeed(rec, key));
			// Owner (or any interest / cells topic): register this socket so its ack,
			// author exclusion, and the interest relevancy cull (or cells own-entity
			// follow) can resolve it by identity.
			if ((cluster || rec.interest || rec.cells) && ctx.ws) rec.registry.set(key, ctx.ws);
			if (rec.cells && ctx.ws) _placeCellSubscriber(rec, key, ctx.ws);
		} else if (ctx.ws && existing.ws !== ctx.ws) {
			// One entity, one owning socket: the socket that last synced owns
			// the command stream. A second tab takes over by syncing, never
			// by racing commands.
			return;
		}
		if (rec.authority.enqueue(key, batch)) _armSmoothTick(rec);
	});

	// Report (or clear) a subscriber's area-of-interest center - the optional
	// `smooth-center` override for a spectator / free-cam whose view is not its own
	// entity's position. Volatile (a lost report is corrected by the next one), and
	// inert unless the topic opted into `interest`. The center is consumed by whichever
	// instance culls this subscriber: the owner (or single-instance) via the tick, and
	// now a non-owner via its receive-side cull tick. A null payload clears the override
	// (reverting to the own-entity center).
	smoothExport.__smoothCenter = live.volatile(async (ctx, ...args) => {
		const roomArgs = args.slice(0, argCount);
		if (guard) await guard(ctx, ...roomArgs);
		if (ctx.ws && _smoothClosedWs.has(ctx.ws)) return;
		const name = resolveName(ctx, roomArgs);
		const rec = _smoothTopics.get(name);
		// Only a live, interest-on or cells topic has a center to act on. No runtime
		// load and no record creation: a center for a topic with no entities yet is
		// moot, so it is dropped, not buffered.
		if (rec === undefined || (!rec.interest && !rec.cells)) return;
		const key = _getIdentityKey(ctx);
		const center = args[argCount];
		// Cells mode: the reported center (or its clearing) drives which cell topics
		// this subscriber is subscribed to - server-driven interest as SUBSCRIPTION.
		// A report passes interest.centerPolicy first ('any' accepts, byte-identical);
		// a REJECTED report behaves like no report: any previously-accepted override
		// is dropped and the block reverts to the own-entity center. Clearing (null)
		// is allowed under every policy - reverting to the own entity is always safe.
		if (rec.cells) {
			if (center === null || center === undefined) {
				rec.cells.centers.delete(key);
				// Revert to following the own entity; re-place from its current position.
				_placeCellSubscriber(rec, key, ctx.ws);
			} else if (center && typeof center === 'object' && typeof center.x === 'number' && typeof center.y === 'number' && Number.isFinite(center.x) && Number.isFinite(center.y)) {
				const applied = _smoothCenterPolicy(rec, ctx, key, center);
				if (applied === null) {
					if (rec.cells.centers.delete(key)) _placeCellSubscriber(rec, key, ctx.ws);
					return;
				}
				rec.cells.centers.set(key, applied);
				_updateCellSubs(rec, key, ctx.ws, applied.x, applied.y);
			}
			return;
		}
		// Membership gate: only a live subscriber of this topic may steer
		// the per-client relevancy cull. Without it one ~40-byte frame from ANY
		// connection forced a full O(subscribers x catalog) interest.compute()
		// pass per tick on an otherwise idle board. The registry is the local
		// subscriber set on every interest path (single-instance and cluster),
		// and centers are node-local, so the local registry is the whole check.
		// (Cells mode above deliberately accepts a pre-sync spectator report; its
		// block placement costs O(block) and self-diffs, never a catalog pass.)
		if (!rec.registry.has(key)) return;
		let centerChanged;
		if (center === null || center === undefined) {
			centerChanged = rec.interest.clearCenter(key);
		} else if (center && typeof center === 'object' && typeof center.x === 'number' && typeof center.y === 'number' && Number.isFinite(center.x) && Number.isFinite(center.y)) {
			// Same policy gate as cells mode; a rejected report clears any stale
			// override so the cull recenters on the own entity.
			const applied = _smoothCenterPolicy(rec, ctx, key, center);
			if (applied === null) centerChanged = rec.interest.clearCenter(key);
			else centerChanged = rec.interest.reportCenter(key, applied.x, applied.y);
		} else {
			return;
		}
		// Force the next tick to recompute relevancy for the new center, and arm one:
		// the owner tick (or single-instance), or a non-owner's receive-side cull tick
		// so the new center takes effect on its locally-culled delivery too. An
		// identical re-report (or a clear with nothing held) changes no center, so
		// it owes no pass (repeated reports must not repeat the O(S x N)
		// recompute).
		if (!centerChanged) return;
		rec.interestDirty = true;
		const cluster = ctx.platform && ctx.platform.smooth;
		if (!cluster || rec.owned || rec.registry.size > 0) _armSmoothTick(rec);
	});

	// Fire-and-forget shot resolution: rewind every candidate to the instant the
	// shooter saw the world, test the shot against those historical positions, and
	// apply the result authoritatively. Registered for every smooth surface
	// alongside command/sync/center (the client always exposes shoot()); on a topic
	// with no `hitTest` the handler is a safe no-op - `rec.lagComp === null` returns
	// early below. Volatile - a lost shot is the app's to retransmit, never the
	// framework's; there is no reply.
	smoothExport.__smoothShoot = live.volatile(async (ctx, ...args) => {
		const roomArgs = args.slice(0, argCount);
		if (guard) await guard(ctx, ...roomArgs);
		let payload = args[argCount];
		if (payload === null || typeof payload !== 'object') return;
		// Wire view: a shot's command arrives packed like any other command.
		const wireShot = cfg.wire !== undefined ? cfg.wire.command : undefined;
		if (wireShot !== undefined) {
			try {
				payload = { ...payload, cmd: wireShot.unpack(payload.cmd) };
			} catch {
				return; // malformed packed command: drop the shot
			}
		}
		if (ctx.ws && _smoothClosedWs.has(ctx.ws)) return;
		const name = resolveName(ctx, roomArgs);
		const rec = _smoothTopics.get(name);
		// No live record, or hit testing off: nothing to resolve. (Defense in depth -
		// the RPC is only registered when hitTest is configured.)
		if (rec === undefined || rec.lagComp === null) return;
		const shooterKey = _getIdentityKey(ctx);
		const cluster = ctx.platform && ctx.platform.smooth;
		if (cluster && !rec.owned) {
			// EDGE: this instance does not own the ring (the authoritative catalog and
			// the history ring live on the owner). Measure latency against the
			// reconstructed owner clock, run the replay defense, and forward the
			// bounded DURATIONS (reach width + rewind age) to the owner, which resolves
			// the shot on its own ring axis - never re-measuring across the hop, which
			// would fold the inter-instance latency into the reach. Inert when the
			// coordinator predates relayShoot (an older extensions build): the shot
			// stays a no-op, exactly as it did before forwarded shots existed.
			if (typeof cluster.relayShoot !== 'function') return;
			const fwd = _smoothEdgeMeasure(rec, ctx, payload, shooterKey, _edgeOwnerNow(rec));
			if (fwd === null) return; // a replayed / older render-time, dropped at the edge
			cluster.relayShoot(rec.wireTopic, shooterKey, cluster.instanceId, {
				cmd: fwd.cmd,
				reach: fwd.reach,
				rewindAge: fwd.rewindAge,
				...(fwd.detect && { detect: fwd.detect })
			});
			return;
		}
		// OWNER / single instance: this instance holds the ring. Measure against the
		// local wall clock and resolve the shot here.
		const shooterEntity = rec.authority.get(shooterKey);
		if (shooterEntity === undefined) return; // a shooter with no entity cannot aim
		const ht = rec.cfg.hitTest;
		const m = _smoothEdgeMeasure(rec, ctx, payload, shooterKey, wallEpoch());
		if (m === null) return;
		// Detection signal (opt-in): fire from this shot's locally-measured picture.
		// A throwing hook never affects the shot.
		if (ht.detectionHook !== undefined && m.detect) {
			try {
				ht.detectionHook({ ...m.detect, identity: shooterKey });
			} catch {
				/* observability only */
			}
		}
		const rewindAt = _smoothRewindAt(m.nowMono, m.reach, m.rewindAge);
		await _smoothResolveShot(rec, name, shooterKey, shooterEntity, ctx.platform, m.cmd, rewindAt, m.nowMono);
	});

	return smoothExport;
};
