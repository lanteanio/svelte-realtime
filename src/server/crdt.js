// @ts-check
import { live } from '../server.js';
import { wallEpoch } from '../shared/runtime.js';
import { LiveError } from './live-error.js';

// Seam: the shared topic-fn resolver (_callTopicFn) stays in server.js (used by
// several live.* families); crdt registration reaches it through this, set at init.
let _callTopicFn;
export function installCrdt(seams) {
	_callTopicFn = seams.callTopicFn;
}

/** @type {{ createCrdtAuthority: Function, normalizeCrdtAccess: Function, createCrdtWireCodec: Function, CRDT_TOPIC_PREFIX: string } | null} */
let _crdtRuntime = null;
/** @type {Promise<any> | null} */
let _crdtRuntimePromise = null;

// Runtime-assembled specifiers with @vite-ignore, for the same reason as the
// smooth loader: a bundler must not pre-resolve them, and node resolves the
// subpaths natively server-side.
const _CRDT_REPLICA_SPECIFIER = 'svelte-adapter-uws' + '/plugins/crdt/replica';
const _CRDT_CODEC_SPECIFIER = 'svelte-adapter-uws' + '/plugins/crdt';

function _loadCrdtRuntime() {
	if (_crdtRuntime) return Promise.resolve(_crdtRuntime);
	if (!_crdtRuntimePromise) {
		// Capture the promise locally: if `_setCrdtRuntime` swaps the runtime
		// while these imports are in flight, the late settlement must not
		// clobber the injected module.
		const p = Promise.all([
			import(/* @vite-ignore */ _CRDT_REPLICA_SPECIFIER),
			import(/* @vite-ignore */ _CRDT_CODEC_SPECIFIER)
		]).then(
			([replica, codec]) => {
				const mod = {
					createCrdtAuthority: replica.createCrdtAuthority,
					normalizeCrdtAccess: replica.normalizeCrdtAccess,
					createCrdtWireCodec: codec.createCrdtWireCodec,
					CRDT_TOPIC_PREFIX: codec.CRDT_TOPIC_PREFIX
				};
				if (_crdtRuntimePromise !== p) {
					return _crdtRuntime !== null ? _crdtRuntime : mod;
				}
				_crdtRuntime = mod;
				return mod;
			},
			(err) => {
				if (_crdtRuntimePromise !== p) {
					if (_crdtRuntime !== null) return _crdtRuntime;
				} else {
					_crdtRuntimePromise = null;
				}
				throw _crdtLoadError(err);
			}
		);
		_crdtRuntimePromise = p;
	}
	return _crdtRuntimePromise;
}

/**
 * Classify a CRDT-plugin import failure. Only a missing module/subpath means
 * version skew; any other failure must surface as itself.
 * @param {any} err
 * @returns {LiveError}
 * @internal exported for tests
 */
export function _crdtLoadError(err) {
	if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) {
		return new LiveError(
			'INTERNAL',
			'live.doc() requires svelte-adapter-uws 0.6.0-next.25 or newer (the CRDT replica plugin is missing from the installed adapter)'
		);
	}
	return new LiveError(
		'INTERNAL',
		'live.doc() failed to load the adapter CRDT plugin: ' + (err && err.message ? err.message : String(err))
	);
}

/**
 * Test seam: inject a CRDT runtime module (or null to restore the lazy
 * loader). Lets the orchestration be exercised against a scripted authority
 * without resolving the adapter subpaths.
 * @param {any} mod
 */
export function _setCrdtRuntime(mod) {
	_crdtRuntime = mod;
	_crdtRuntimePromise = null;
}

/**
 * Per-declaration document records, keyed by the declaration's topic (a
 * string topic, or the topic function's source text). DELIBERATELY not
 * cleared by `_prepareHmr`: a document replica holds edits that exist
 * nowhere else until the persistence schedule runs, so the records survive a
 * hot reload the way flag value cells do, and a re-imported declaration
 * re-attaches by key. The mutable `current` config is swapped on re-attach so
 * edited persist hooks and knobs take effect against the LIVE replicas (the
 * authority reads its hooks through a facade over `current`).
 * @type {Map<string, { key: string, authority: any, codec: any, prefix: string, platform: any, current: any, accessByWs: WeakMap<any, Map<string, any>> }>}
 */
const _crdtDecls = new Map();

/**
 * Per-socket acquired documents, for the close drain: ws -> Map of
 * `declKey\u0000topicName` -> { rec, name }. WeakMap so a vanished socket
 * never anchors the bookkeeping.
 * `mounts` is the set of live mount ids (several client stores on one
 * connection can resolve to one document); the slot holds exactly one
 * authority reference and one subscription until the LAST mount closes.
 * @type {WeakMap<any, Map<string, { rec: any, name: string, mounts: Set<number> }>>}
 */
const _crdtWsDocs = new WeakMap();

/**
 * Sockets whose close path has already run - the same ghost guard as smooth:
 * the sync handler awaits (guard, runtime load, replica load, subscribe), so
 * a socket can close mid-handler; re-checking here prevents acquiring a
 * reference no close can ever release.
 */
export const _crdtClosedWs = new WeakSet();

/**
 * Registration count per declaration key, to warn when two LIVE declarations
 * share one topic: they would share one replica set while the persistence
 * hooks follow whichever declaration synced last - a silent persistence
 * hazard. Cleared on hot reload (a re-import re-registers the same
 * declaration once; that is a re-attach, not a duplicate).
 * @type {Map<string, number>}
 */
export const _crdtDeclRegistrations = new Map();

/** Test seam: destroy every document record (replicas included). */
export function _resetCrdt() {
	for (const rec of _crdtDecls.values()) {
		if (rec.authority) {
			try { rec.authority.destroy(); } catch { /* test teardown */ }
		}
	}
	_crdtDecls.clear();
	_crdtDeclRegistrations.clear();
}

/** Release one socket's reference on one document and forget its access record. */
function _crdtRelease(rec, ws, name) {
	const docs = _crdtWsDocs.get(ws);
	if (docs) docs.delete(rec.key + '\u0000' + name);
	const acc = rec.accessByWs.get(ws);
	if (acc) acc.delete(name);
	if (rec.authority) rec.authority.release(name);
}

/**
 * Close-path drain: release every document reference a closing socket holds.
 * The adapter clears the socket's topic subscriptions itself; this returns
 * the replica references so empty documents persist-on-empty and unload.
 * @param {any} ws
 */
export function _drainCrdtOnClose(ws) {
	const docs = _crdtWsDocs.get(ws);
	if (!docs || docs.size === 0) return;
	const entries = [...docs.values()];
	docs.clear();
	for (const { rec, name } of entries) {
		const acc = rec.accessByWs.get(ws);
		if (acc) acc.delete(name);
		if (rec.authority) rec.authority.release(name);
	}
}

/**
 * Fan one document update out to a record's local subscribers over the
 * reserved wire topic (excluding the originating socket when given). Pure over
 * its arguments - the record carries the platform, codec, and prefix - so both
 * the per-connection update path and the cluster relay loop call it.
 * @param {any} rec @param {string} name @param {Uint8Array | number[]} bytes @param {any} [excludeWs]
 */
function _publishUpdate(rec, name, bytes, excludeWs) {
	const platform = rec.platform;
	const wireTopic = rec.prefix + name;
	const data = { op: 'update', bytes: Array.from(bytes) };
	if (rec.codec && platform && typeof platform.publishWire === 'function') {
		platform.publishWire(wireTopic, 'crdt', data, rec.codec, excludeWs !== undefined ? { excludeWs } : undefined);
	} else if (platform) {
		// Older platform: JSON envelope for everyone; the channel's JSON tap
		// applies it identically. No exclusion walk - the idempotent merge
		// makes the echoed frame a no-op for its sender.
		platform.publish(wireTopic, 'crdt', data, { compress: false });
	}
}

/**
 * Cluster coordinators (`platform.crdt`) whose inbound relay handlers have
 * been wired. One registration per coordinator for the process lifetime: the
 * handlers dispatch by declKey to the live record and apply + fan out, so the
 * relay loop is shared across every declaration. WeakSet: a replaced
 * coordinator is collectable.
 */
const _crdtClustersWired = new WeakSet();

/**
 * Register the inbound relay handlers on a cluster coordinator, once. A peer's
 * update or sync reply is applied to THIS instance's replica and fanned out to
 * THIS instance's local subscribers (no exclude - the originator is on another
 * instance, and no relay-back happens because only client-originated updates
 * relay). A peer's sync request is answered from this instance's replica when
 * it holds the topic. Every handler resolves the record by declKey and acts
 * only when this instance currently holds the topic (a relayed frame for a
 * document no local client mounts is correctly ignored - it will cold-sync
 * when one arrives).
 * @param {any} crdt
 */
function _ensureCrdtCluster(crdt) {
	if (!crdt || typeof crdt.onMessage !== 'function' || _crdtClustersWired.has(crdt)) return;
	_crdtClustersWired.add(crdt);
	crdt.onMessage({
		onUpdate: (declKey, topic, bytes) => {
			const rec = _crdtDecls.get(declKey);
			if (!rec || !rec.authority || !rec.authority.has(topic)) return;
			const out = rec.authority.applyUpdate(topic, bytes);
			if (out) _publishUpdate(rec, topic, out, undefined);
		},
		onSyncRequest: (declKey, topic, sv, fromInstance) => {
			const rec = _crdtDecls.get(declKey);
			if (!rec || !rec.authority || !rec.authority.has(topic)) return;
			const diff = rec.authority.diff(topic, Array.isArray(sv) ? sv : null);
			if (diff && diff.length > 0 && typeof crdt.sendSyncReply === 'function') {
				crdt.sendSyncReply(declKey, topic, Array.from(diff), fromInstance);
			}
		},
		onSyncReply: (declKey, topic, bytes) => {
			const rec = _crdtDecls.get(declKey);
			if (!rec || !rec.authority || !rec.authority.has(topic)) return;
			const out = rec.authority.applyUpdate(topic, bytes);
			if (out) _publishUpdate(rec, topic, out, undefined);
		}
	});
}

export function _crdtRegister(kind, config) {
	const label = 'live.' + kind + '()';
	if (!config || typeof config !== 'object') {
		throw new Error('[svelte-realtime] ' + label + ' requires a config object\n  See: https://svti.me/doc');
	}
	const topicFn = config.topic;
	if (typeof topicFn !== 'function' && typeof topicFn !== 'string') {
		throw new Error('[svelte-realtime] ' + label + ' requires a topic (string or (ctx, ...args) => string)\n  See: https://svti.me/doc');
	}
	if (config.guard !== undefined && typeof config.guard !== 'function') {
		throw new Error('[svelte-realtime] ' + label + ' guard must be a function returning a boolean or a {read, write, comment} record');
	}
	if (config.persist !== undefined && (config.persist === null || typeof config.persist !== 'object')) {
		throw new Error('[svelte-realtime] ' + label + ' persist must be an object with load/store hooks');
	}
	for (const knob of ['debounceWait', 'debounceMaxWait', 'snapshotEvery']) {
		if (config[knob] !== undefined && !(typeof config[knob] === 'number' && Number.isFinite(config[knob]) && config[knob] >= 0)) {
			throw new Error('[svelte-realtime] ' + label + ' ' + knob + ' must be a non-negative number');
		}
	}
	const guard = config.guard;
	const argCount = config.topicArgs !== undefined
		? config.topicArgs
		: (typeof topicFn === 'function' ? Math.max(0, topicFn.length - 1) : 0);
	const declKey = typeof topicFn === 'string' ? 'topic:' + topicFn : 'fn:' + topicFn.toString();
	const priorRegistrations = _crdtDeclRegistrations.get(declKey) || 0;
	_crdtDeclRegistrations.set(declKey, priorRegistrations + 1);
	if (priorRegistrations > 0) {
		// Two distinct live declarations resolve to one declKey (same string
		// topic, or byte-identical topic-function source). They will share
		// one replica set while the persistence hooks follow whichever
		// declaration synced last - a silent persistence hazard. A hot reload
		// re-registers the SAME declaration once (a re-attach, not a
		// duplicate): _prepareHmr clears this counter so the re-import does
		// not trip the warning.
		console.warn(
			'[svelte-realtime] two ' + label + '-family declarations share the topic ' +
			(typeof topicFn === 'string' ? '"' + topicFn + '"' : '(same topic function source)') +
			': they share one replica set and the persistence hooks follow whichever synced last. ' +
			'Declare one document per topic.\n  See: https://svti.me/doc'
		);
	}
	const cfg = {
		persist: config.persist,
		debounceWait: config.debounceWait,
		debounceMaxWait: config.debounceMaxWait,
		snapshotEvery: config.snapshotEvery,
		persistOnEmpty: config.persistOnEmpty,
		gc: config.gc,
		onError: config.onError
	};

	const resolveName = (ctx, roomArgs) =>
		typeof topicFn === 'function' ? _callTopicFn(topicFn, ctx, roomArgs) : topicFn;

	let warnedNoGuard = false;

	/** Attach (or re-attach after HMR) the declaration's live record. */
	function _record(rt) {
		let rec = _crdtDecls.get(declKey);
		if (rec === undefined) {
			rec = {
				key: declKey,
				authority: null,
				codec: rt.createCrdtWireCodec(),
				prefix: rt.CRDT_TOPIC_PREFIX,
				platform: null,
				current: cfg,
				accessByWs: new WeakMap()
			};
			// The authority reads its hooks and knobs through `rec.current`,
			// so an HMR re-attach updates behavior without rebuilding the
			// replicas (which hold edits that exist nowhere else yet).
			rec.authority = rt.createCrdtAuthority({
				persist: {
					load: (topic) => {
						const p = rec.current.persist;
						return p && typeof p.load === 'function' ? p.load(topic) : null;
					},
					store: async (topic, bytes) => {
						const p = rec.current.persist;
						if (!p || typeof p.store !== 'function') return;
						// Clustered: gate the write behind a per-topic persist
						// lease so exactly one instance writes a topic's
						// snapshot - no divergent-snapshot clobber. acquirePersist
						// throws on a Redis error (the authority then retries) and
						// returns false when another instance is the writer (skip;
						// that instance persists the converged state). Single
						// instance (no platform.crdt): always write.
						const crdt = rec.platform && rec.platform.crdt;
						if (crdt && typeof crdt.acquirePersist === 'function') {
							const mayWrite = await crdt.acquirePersist(topic);
							// Decline (not fail): the lease holder writes the
							// converged state. Returning false keeps the topic
							// dirty so this instance re-probes the lease and
							// takes over if the holder dies, without pinning the
							// replica or surfacing a spurious error.
							if (!mayWrite) return false;
						}
						return p.store(topic, bytes);
					}
				},
				debounceWait: cfg.debounceWait,
				debounceMaxWait: cfg.debounceMaxWait,
				snapshotEvery: cfg.snapshotEvery,
				persistOnEmpty: cfg.persistOnEmpty,
				gc: cfg.gc,
				onError: (err, info) => {
					const handler = rec.current.onError;
					if (typeof handler === 'function') {
						try { handler(err, info); } catch { /* the host's handler must not break the schedule */ }
					} else {
						console.error('[svelte-realtime] ' + label + ' persist ' + info.op + ' failed for "' + info.topic + '":', err);
					}
				}
			});
			_crdtDecls.set(declKey, rec);
		} else {
			// Re-attach (HMR or duplicate declaration): adopt the edited
			// hooks/knobs that route through `current`. Schedule-shape knobs
			// were captured at authority creation and keep their old values
			// until restart - documented, and far cheaper than migrating
			// live replicas.
			rec.current = cfg;
		}
		return rec;
	}

	const docExport = /** @type {any} */ ({});
	docExport.__isDoc = true;
	docExport.__docKind = kind;

	docExport.__docSync = live(async (ctx, ...args) => {
		const roomArgs = args.slice(0, argCount);
		const stateVector = args[argCount];
		// The mount identity: lets the slot count mounts rather than syncs
		// (re-syncs re-send the same id; a second store on the same document
		// sends its own). Absent or malformed collapses to one shared id -
		// the single-mount semantics.
		const rawMount = args[argCount + 1];
		const mountId = typeof rawMount === 'number' && Number.isFinite(rawMount) ? rawMount : 0;
		let access;
		if (guard) {
			const rt0 = await _loadCrdtRuntime();
			access = rt0.normalizeCrdtAccess(await guard(ctx, ...roomArgs));
		} else {
			if (!warnedNoGuard && process.env.NODE_ENV === 'production') {
				warnedNoGuard = true;
				console.warn('[svelte-realtime] ' + label + ' has no guard: every connection can read AND write this document. Add a guard returning {read, write} to scope access.\n  See: https://svti.me/doc');
			}
			access = { read: true, write: true, comment: true };
		}
		if (!access.read) {
			throw new LiveError('FORBIDDEN', 'document read denied');
		}
		const name = resolveName(ctx, roomArgs);
		const rt = await _loadCrdtRuntime();
		const rec = _record(rt);
		// The record follows the caller's live platform (dev-server restarts
		// and multi-platform test processes otherwise publish into a dead
		// instance), matching the smooth record discipline.
		rec.platform = ctx.platform;
		const wsKey = rec.key + '\u0000' + name;
		const docs = ctx.ws ? _crdtWsDocs.get(ctx.ws) : undefined;
		const alreadyHeld = !!(docs && docs.has(wsKey));
		if (!alreadyHeld) {
			try {
				await rec.authority.acquire(name);
			} catch (err) {
				throw new LiveError(
					'INTERNAL',
					'document load failed for "' + name + '": ' + (err && err.message ? err.message : String(err))
				);
			}
		}
		const wireTopic = rec.prefix + name;
		// Walk-visible membership for the reserved wire topic, same as smooth:
		// reserved-prefix topics never ride the client's own subscribe frames.
		if (ctx.ws && ctx.platform && typeof ctx.platform.subscribe === 'function') {
			const denial = await ctx.platform.subscribe(ctx.ws, wireTopic);
			if (denial) {
				if (!alreadyHeld) rec.authority.release(name);
				throw new LiveError(
					denial === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'FORBIDDEN',
					'document topic subscribe denied: ' + denial
				);
			}
		} else if (ctx.ws && typeof ctx.ws.subscribe === 'function') {
			try {
				ctx.ws.subscribe(wireTopic);
			} catch {}
		}
		// Liveness re-check after the awaits: if the socket closed while the
		// guard / load / subscribe was pending, its close drain already ran
		// and acquiring now would leak a reference no close can release.
		if (ctx.ws && _crdtClosedWs.has(ctx.ws)) {
			if (!alreadyHeld) rec.authority.release(name);
			throw new LiveError('CONNECTION_CLOSED', 'WebSocket closed during document sync');
		}
		if (ctx.ws) {
			let m = _crdtWsDocs.get(ctx.ws);
			if (!m) {
				m = new Map();
				_crdtWsDocs.set(ctx.ws, m);
			}
			const held = m.get(wsKey);
			if (held) {
				// The slot already exists: either a re-sync of a known mount,
				// or a CONCURRENT first-sync registered while this call's
				// awaits were pending - in which case this call's acquire is
				// surplus and is returned so the reference count stays one
				// per slot.
				if (!alreadyHeld) rec.authority.release(name);
				held.mounts.add(mountId);
			} else {
				// One slot per (connection, document), counting MOUNTS:
				// several client stores on one connection can resolve to the
				// same document, and one store's close must not sever the
				// others' subscription or authorization.
				m.set(wsKey, { rec, name, mounts: new Set([mountId]) });
			}
			// Cache (or refresh - a re-sync re-runs the guard, so a downgrade
			// takes effect here) the access record for the update path.
			let acc = rec.accessByWs.get(ctx.ws);
			if (!acc) {
				acc = new Map();
				rec.accessByWs.set(ctx.ws, acc);
			}
			acc.set(name, access);
		}
		const diff = rec.authority.diff(name, Array.isArray(stateVector) ? stateVector : null);
		const sv = rec.authority.stateVector(name);
		// Clustered: a cold-loaded replica is only as fresh as the last
		// persisted snapshot, so wire the relay loop (once) and, on a cold
		// load, ask peers for anything newer than what we just loaded. A peer
		// holding the topic replies with the structs we lack; the reply
		// applies on top of the snapshot and fans out to this socket as a
		// normal update (idempotent merge, so applying both is safe).
		const _crdtSync = ctx.platform && ctx.platform.crdt;
		if (_crdtSync) {
			_ensureCrdtCluster(_crdtSync);
			if (!alreadyHeld && typeof _crdtSync.requestSync === 'function') {
				_crdtSync.requestSync(rec.key, name, sv === null ? [] : Array.from(sv));
			}
		}
		// A connection-less caller (a direct server-side invocation) gets the
		// exchange snapshot but holds nothing: there is no close or disconnect
		// to pair a reference with.
		if (!ctx.ws && !alreadyHeld) rec.authority.release(name);
		return {
			topic: name,
			access,
			t: wallEpoch(),
			diff: diff === null ? [] : Array.from(diff),
			sv: sv === null ? [] : Array.from(sv)
		};
	});

	docExport.__docUpdate = live.volatile(async (ctx, ...args) => {
		const roomArgs = args.slice(0, argCount);
		const bytes = args[argCount];
		if (!Array.isArray(bytes) || bytes.length === 0) return;
		if (!ctx.ws || _crdtClosedWs.has(ctx.ws)) return;
		const rec = _crdtDecls.get(declKey);
		if (!rec || !rec.authority) return; // no completed sync anywhere yet
		const name = resolveName(ctx, roomArgs);
		// The cached record is the authorization: it only exists when THIS
		// connection passed the guard for THIS document at sync time. No
		// record (never synced, or released) or no write right: drop - the
		// client knows it is read-only up front via the sync reply.
		const acc = rec.accessByWs.get(ctx.ws);
		const access = acc ? acc.get(name) : undefined;
		if (!access || !access.write) return;
		// Apply + fan-out is one synchronous unit from here (no awaits): an
		// update arriving in the next task sees this one's applied state.
		const out = rec.authority.applyUpdate(name, bytes);
		if (out === null) return; // unloaded or malformed: drop, sync reconciles
		rec.platform = ctx.platform;
		_publishUpdate(rec, name, out, ctx.ws);
		// Clustered: relay the applied bytes so every other instance's replica
		// converges and its local subscribers see the edit. Only client-
		// originated updates relay (the inbound relay handler never re-relays),
		// so there is no loop; peers echo-suppress our own instance id.
		const crdt = ctx.platform && ctx.platform.crdt;
		if (crdt && typeof crdt.relayUpdate === 'function') {
			crdt.relayUpdate(rec.key, name, Array.from(out));
		}
	});

	docExport.__docClose = live.volatile(async (ctx, ...args) => {
		const roomArgs = args.slice(0, argCount);
		const rawMount = args[argCount];
		const mountId = typeof rawMount === 'number' && Number.isFinite(rawMount) ? rawMount : 0;
		if (!ctx.ws) return;
		const rec = _crdtDecls.get(declKey);
		if (!rec) return;
		const name = resolveName(ctx, roomArgs);
		const docs = _crdtWsDocs.get(ctx.ws);
		const held = docs ? docs.get(rec.key + '\u0000' + name) : undefined;
		if (!held) return;
		held.mounts.delete(mountId);
		// Other stores on this connection still mount the document: keep the
		// subscription, the authorization, and the reference.
		if (held.mounts.size > 0) return;
		_crdtRelease(rec, ctx.ws, name);
		if (ctx.platform && typeof ctx.platform.unsubscribe === 'function') {
			try { ctx.platform.unsubscribe(ctx.ws, rec.prefix + name); } catch { /* freed handle */ }
		} else if (typeof ctx.ws.unsubscribe === 'function') {
			try { ctx.ws.unsubscribe(rec.prefix + name); } catch { /* freed handle */ }
		}
	});

	return docExport;
}
