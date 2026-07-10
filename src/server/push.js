// @ts-check
import { LiveError } from './live-error.js';
import { assert } from '../shared/assert.js';
import { _validIdReason, _MAX_USER_ID_LENGTH } from './validate.js';
import { _IS_DEV } from './env.js';
import { state } from './state.js';
import { close } from '../server.js';

/**
 * Per-userId connection registry. Source of truth for `live.push({ userId })`
 * routing. Populated by `pushHooks.open`, drained by `pushHooks.close`.
 * Stores the platform alongside the ws so the wrapper can call
 * `platform.request(ws, ...)` without separate threading.
 *
 * Last-write-wins on multi-device: a second connection by the same user
 * replaces the first as the push target. Older connections still receive
 * topic publishes via their own subscriptions; only push routing flips.
 * Cluster-wide push (any instance routing to any user's ws) is a separate
 * primitive in the extensions package.
 * @type {Map<string, { ws: any, platform: any }>}
 */
export const _pushRegistry = new Map();

/**
 * Reverse index from ws back to its registered userId. Used by
 * `pushHooks.close` to deregister without re-running identify(ws),
 * which may not be reliable on close (some platforms clear userData).
 * WeakMap so sockets remain GC-eligible if close is missed.
 * @type {WeakMap<object, string>}
 */
export const _wsToPushUserId = new WeakMap();

/**
 * Per-sessionId connection registry. Source of truth for
 * `live.push({ sessionId })` routing. Independent of the userId registry: a
 * connection may carry a userId, a sessionId, both, or neither. Resume-aware
 * by the same last-write-wins lifecycle as the userId registry - a session that
 * reconnects with the same id re-runs `pushHooks.open` and the entry flips to the
 * live socket. Cluster-wide sessionId routing is a separate extensions primitive.
 * @type {Map<string, { ws: any, platform: any }>}
 */
export const _pushSessionRegistry = new Map();

/**
 * Reverse index from ws back to its registered sessionId (mirror of
 * `_wsToPushUserId`). WeakMap so sockets stay GC-eligible if close is missed.
 * @type {WeakMap<object, string>}
 */
export const _wsToPushSessionId = new WeakMap();

/** One-shot flag for the MAX_PUSH_REGISTRY warning (userId). Reset by `_resetPushRegistry`. */
let _pushRegistryWarnFired = false;

/** One-shot flag for the MAX_PUSH_REGISTRY warning (sessionId). Reset by `_resetPushRegistry`. */
let _pushSessionRegistryWarnFired = false;

/**
 * Default identify: read user_id then userId from ws.getUserData().
 * Returns undefined for anonymous connections (skipped by pushHooks.open).
 * @param {any} ws
 * @returns {string | null | undefined}
 */
function _defaultPushIdentify(ws) {
	let data;
	try { data = ws.getUserData?.(); } catch { return undefined; }
	if (!data) return undefined;
	return data.user_id != null ? data.user_id : data.userId;
}

/**
 * Default session identify: read session_id then sessionId from ws.getUserData().
 * Returns undefined for connections that carry no session (skipped by pushHooks.open).
 * @param {any} ws
 * @returns {string | null | undefined}
 */
function _defaultPushSessionIdentify(ws) {
	let data;
	try { data = ws.getUserData?.(); } catch { return undefined; }
	if (!data) return undefined;
	return data.session_id != null ? data.session_id : data.sessionId;
}

function _getPushIdentify() {
	return state.pushIdentify || _defaultPushIdentify;
}

function _getPushSessionIdentify() {
	return state.pushSessionIdentify || _defaultPushSessionIdentify;
}

/**
 * Optional remote-registry surface used by `live.push` when the userId
 * is not registered on this instance. The connection registry in
 * `svelte-adapter-uws-extensions/redis/registry` conforms to this shape;
 * pass it via `live.configurePush({ remoteRegistry })` to enable
 * cluster-routed push.
 *
 * @type {{ request: (target: string, event: string, data?: any, options?: { timeoutMs?: number }) => Promise<any> } | null}
 */
let _remoteRegistry = null;

/**
 * Configure the push registry. Accepts two independent fields:
 *
 * - `identify` - override how `pushHooks.open` extracts the userId
 *   from a connecting WebSocket. Defaults to reading
 *   `ws.getUserData()?.user_id ?? ws.getUserData()?.userId`. Pass a
 *   function to override; pass `null` (in `config.identify`) to clear.
 * - `sessionIdentify` - override how `pushHooks.open` extracts the
 *   sessionId for `live.push({ sessionId })` routing. Defaults to reading
 *   `ws.getUserData()?.session_id ?? ws.getUserData()?.sessionId`. Pass a
 *   function to override; pass `null` to clear. Independent of `identify`:
 *   a connection may register under a userId, a sessionId, both, or neither.
 * - `remoteRegistry` - an object with a
 *   `request(userId, event, data, options)` method. When supplied,
 *   `live.push({ userId })` falls back to `remoteRegistry.request(...)`
 *   if the userId is not registered on this instance, enabling
 *   cluster-routed push. If it ALSO exposes a
 *   `requestSession(sessionId, event, data, options)` method (the
 *   extensions connection registry created with a `sessionIdentify`
 *   option does), `live.push({ sessionId })` / `live.notify({ sessionId })`
 *   route cluster-wide too; otherwise the sessionId target stays
 *   single-instance. Pass `null` to clear.
 *
 * The whole-config form `null` clears both slots.
 *
 * **Recommended call site (svelte-adapter-uws >= 0.5.0-next.15):** the
 * `init({ platform })` hook in `hooks.ws.js`, alongside
 * `setCronPlatform`. The Redis client is typically already connected by
 * the time `init` fires, and the hook completes before any `upgrade` /
 * `open` runs - so the cluster-routing path is wired before the first
 * request can reach `live.push`. Calling at module top-level also works
 * but is brittle if your Redis client is created inside an async setup
 * function or behind a module that imports lazily.
 *
 * @param {{ identify?: ((ws: any) => string | null | undefined) | null, sessionIdentify?: ((ws: any) => string | null | undefined) | null, remoteRegistry?: { request: Function, requestSession?: Function } | null } | null} config
 *
 * @example
 * ```js
 * // src/hooks.ws.js (recommended call site, adapter next.15+)
 * import { live } from 'svelte-realtime/server';
 * import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry';
 *
 * export function init({ platform }) {
 *     const registry = createConnectionRegistry(redis, { identify: (ws) => ws.getUserData()?.userId });
 *     live.configurePush({ remoteRegistry: registry });
 * }
 * ```
 *
 * @example
 * ```js
 * // Identify-only override (no cluster routing). Module top-level is
 * // fine for this case - no async setup involved.
 * import { live } from 'svelte-realtime/server';
 * live.configurePush({ identify: (ws) => ws.getUserData()?.account?.id });
 * ```
 */
const _liveConfigurePush = function configurePush(config) {
	if (config === null) {
		state.pushIdentify = null;
		state.pushSessionIdentify = null;
		_remoteRegistry = null;
		return;
	}
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] live.configurePush: config must be an object or null');
	}
	if (config.identify === undefined && config.sessionIdentify === undefined && config.remoteRegistry === undefined) {
		throw new Error('[svelte-realtime] live.configurePush: config must include at least one of identify, sessionIdentify, or remoteRegistry');
	}
	if (config.identify !== undefined) {
		if (config.identify === null) {
			state.pushIdentify = null;
		} else if (typeof config.identify !== 'function') {
			throw new Error('[svelte-realtime] live.configurePush: identify must be a function or null');
		} else {
			state.pushIdentify = config.identify;
		}
	}
	if (config.sessionIdentify !== undefined) {
		if (config.sessionIdentify === null) {
			state.pushSessionIdentify = null;
		} else if (typeof config.sessionIdentify !== 'function') {
			throw new Error('[svelte-realtime] live.configurePush: sessionIdentify must be a function or null');
		} else {
			state.pushSessionIdentify = config.sessionIdentify;
		}
	}
	if (config.remoteRegistry !== undefined) {
		if (config.remoteRegistry === null) {
			_remoteRegistry = null;
		} else if (typeof config.remoteRegistry !== 'object' || typeof config.remoteRegistry.request !== 'function') {
			throw new Error('[svelte-realtime] live.configurePush: remoteRegistry must expose a .request(userId, event, data, options) method');
		} else {
			_remoteRegistry = config.remoteRegistry;
		}
	}
};

/**
 * Hook functions to wire from `hooks.ws.js` so `live.push({ userId })` can
 * route to the right WebSocket. `open` registers the connection in the
 * push registry; `close` deregisters it.
 *
 * @example
 * ```js
 * // hooks.ws.js
 * import { pushHooks } from 'svelte-realtime/server';
 *
 * export const open = pushHooks.open;
 * export const close = pushHooks.close;
 * ```
 *
 * Compose with other hooks by calling pushHooks.open / pushHooks.close
 * inside your own handlers.
 */
export const pushHooks = {
	/**
	 * Register the connection in the push registry. Reads identify(ws)
	 * (defaulting to ws.getUserData()?.user_id / userId) and stores the
	 * { ws, platform } pair keyed by userId. Anonymous connections
	 * (identify returning null/undefined) are silently skipped.
	 *
	 * @param {any} ws
	 * @param {{ platform: any }} ctx
	 */
	open(ws, ctx) {
		if (!ctx || !ctx.platform) {
			throw new Error('[svelte-realtime] pushHooks.open: missing platform on hook context');
		}
		const platform = ctx.platform;

		// userId registration. A connection with no userId (anonymous) is skipped
		// here but may still register a sessionId below - the two are independent.
		const userId = _getPushIdentify()(ws);
		if (userId != null && userId !== '') {
			const reason = _validIdReason(userId, 'userId');
			if (reason !== null) {
				throw new Error('[svelte-realtime] pushHooks.open: ' + reason + '. identify(ws) must return a non-empty userId string that is safe to embed in a topic name (no control chars / CR / LF / NUL / quotes / backslash, max ' + _MAX_USER_ID_LENGTH + ' chars), or null / undefined for anonymous connections.');
			}
			if (!_pushRegistry.has(userId) && _pushRegistry.size >= state.maxPushRegistry) {
				if (!_pushRegistryWarnFired) {
					_pushRegistryWarnFired = true;
					console.warn(
						"[svelte-realtime] push registry reached MAX_PUSH_REGISTRY=" + state.maxPushRegistry +
						"; new userIds will not be registered for `live.push({ userId })` until existing entries clear.\n" +
						"  This usually indicates push registrations are not being released on disconnect.\n" +
						"  Check that hooks.ws.js wires `pushHooks.close` and that the upstream identify(ws) is stable per-user.\n" +
						"  See: https://svti.me/push-registry"
					);
				}
			} else {
				_pushRegistry.set(userId, { ws, platform });
				_wsToPushUserId.set(ws, userId);
			}
		}

		// sessionId registration (independent of userId). Resume-aware by the same
		// last-write-wins lifecycle: a session reconnecting with the same id re-runs
		// open and the entry flips to the live socket.
		const sessionId = _getPushSessionIdentify()(ws);
		if (sessionId != null && sessionId !== '') {
			const reason = _validIdReason(sessionId, 'sessionId');
			if (reason !== null) {
				throw new Error('[svelte-realtime] pushHooks.open: ' + reason + '. sessionIdentify(ws) must return a non-empty sessionId string that is safe to embed in a topic name (no control chars / CR / LF / NUL / quotes / backslash, max ' + _MAX_USER_ID_LENGTH + ' chars), or null / undefined for connections without a session.');
			}
			if (!_pushSessionRegistry.has(sessionId) && _pushSessionRegistry.size >= state.maxPushRegistry) {
				if (!_pushSessionRegistryWarnFired) {
					_pushSessionRegistryWarnFired = true;
					console.warn(
						"[svelte-realtime] push session registry reached MAX_PUSH_REGISTRY=" + state.maxPushRegistry +
						"; new sessionIds will not be registered for `live.push({ sessionId })` until existing entries clear.\n" +
						"  This usually indicates push registrations are not being released on disconnect.\n" +
						"  Check that hooks.ws.js wires `pushHooks.close` and that the upstream sessionIdentify(ws) is stable per-session.\n" +
						"  See: https://svti.me/push-registry"
					);
				}
			} else {
				_pushSessionRegistry.set(sessionId, { ws, platform });
				_wsToPushSessionId.set(ws, sessionId);
			}
		}
	},
	/**
	 * Adapter close hook. Drains both the per-userId push registry AND
	 * the realtime stream-subscription bookkeeping (per-topic ws-counts,
	 * silent-topic watchdogs, `__onUnsubscribe` callbacks). Routes through
	 * the module-scope `close` when the adapter passes a `ctx` - which it
	 * always does in production - so a single
	 * `export const close = pushHooks.close` re-export from hooks.ws.js
	 * covers both concerns. Falls back to push-only behavior when called
	 * directly without `ctx` (test setups, custom flows) so the historical
	 * one-arg signature keeps working.
	 *
	 * @param {any} ws
	 * @param {{ platform: any, subscriptions?: any } | undefined} [ctx]
	 */
	close(ws, ctx) {
		if (ctx) {
			// Realtime close drains both stream subscriptions and the push
			// registry. Idempotent across repeat calls and across users
			// who compose pushHooks.close + the realtime close manually --
			// a second pass finds nothing to remove.
			close(ws, ctx);
			return;
		}
		// Direct one-arg call (legacy, tests, custom flows): drain the
		// push registries only. The stream-subscription bookkeeping path
		// requires `ctx.platform` for `__onUnsubscribe` callbacks; without
		// it, the safe behavior is "do what the original signature did."
		const userId = _wsToPushUserId.get(ws);
		if (userId != null) {
			_wsToPushUserId.delete(ws);
			const entry = _pushRegistry.get(userId);
			// push-registry invariant: if userId was tracked in _wsToPushUserId,
			// the registry should still have an entry for that userId (possibly
			// pointing at a different ws if the user reconnected on another
			// device). Missing entry means an external mutation cleared it.
			assert(entry !== undefined, 'realtime/push-registry.entry-tracked', { userIdLen: userId.length });
			if (entry && entry.ws === ws) _pushRegistry.delete(userId);
		}
		_deregisterPushSession(ws);
	}
};

/**
 * Right-to-erasure (`live.forget`): drop a user's push-registry entry, its ws
 * reverse mapping, and EVERY session entry the user's sockets hold. The userId
 * registry is the durable-in-memory routing record keyed by raw userId (no
 * tenant segment - it relies on globally-unique userIds, so the tenant cannot
 * disambiguate here). Session entries are keyed independently of userId, so
 * beyond the common same-socket drain, a scan over the bounded session
 * registry attributes each entry's socket back to its userId through the ws
 * reverse map - a session the user registered on ANOTHER socket (an older
 * connection whose userId routing was superseded) must not survive its owner's
 * erasure.
 *
 * Returns the number of routing/session entries removed so the forget cascade
 * can total a per-surface count.
 * @param {string} userId
 * @returns {number}
 */
export function _purgePushUser(userId) {
	let count = 0;
	const entry = _pushRegistry.get(userId);
	if (entry) {
		_pushRegistry.delete(userId);
		count++;
		if (entry.ws) {
			_wsToPushUserId.delete(entry.ws);
			// Same socket usually also carries the push sessionId; drain it too.
			_deregisterPushSession(entry.ws);
		}
	}
	// Cross-socket sessions: O(sessions) over the bounded registry, forget-only
	// (never a hot path). Only the primary socket's reverse-map entry was
	// deleted above; every OTHER socket the user registered from still maps
	// back to the userId, which is exactly how this scan attributes them.
	for (const sessionEntry of [..._pushSessionRegistry.values()]) {
		if (sessionEntry.ws && _wsToPushUserId.get(sessionEntry.ws) === userId) {
			_deregisterPushSession(sessionEntry.ws);
			count++;
		}
	}
	return count;
}

/**
 * Deregister a socket's sessionId push entry. Shared by `pushHooks.close`
 * (the direct one-arg path) and the realtime `close` drain in server.js, so a
 * single `export const close = pushHooks.close` covers the session registry too.
 * Idempotent: a second pass finds nothing tracked.
 * @param {any} ws
 */
export function _deregisterPushSession(ws) {
	const sessionId = _wsToPushSessionId.get(ws);
	if (sessionId == null) return;
	_wsToPushSessionId.delete(ws);
	const entry = _pushSessionRegistry.get(sessionId);
	// Same invariant as the userId registry: a tracked sessionId should still
	// have an entry (possibly pointing at a newer socket after a resume).
	assert(entry !== undefined, 'realtime/push-session-registry.entry-tracked', { sessionIdLen: sessionId.length });
	if (entry && entry.ws === ws) _pushSessionRegistry.delete(sessionId);
}

/**
 * Send a server-initiated request to a connected user and await the reply.
 *
 * Lookup order:
 * 1. **Remote registry (when configured)** - the optional `remoteRegistry`
 *    set via `live.configurePush({ remoteRegistry })` is the cluster-wide
 *    source of truth for "which instance currently owns this userId" (most-
 *    recently-opened wins via the registry's last-write-wins userToInstance
 *    map). `live.push` delegates to `remoteRegistry.request(userId, ...)`
 *    so the recipient is deterministic regardless of which instance the
 *    caller runs on. The registry's own self-targeting short-circuit
 *    (`registry.js: ownerInstanceId === instanceId`) means no extra Redis
 *    hop when the canonical owner IS this instance -- single-tab
 *    performance is unchanged.
 * 2. **Local registry (fallback)** - the per-userId Map populated by
 *    `pushHooks.open` / `pushHooks.close`. When no `remoteRegistry` is
 *    configured (single-instance dev), this is the only path. When a
 *    `remoteRegistry` IS configured, the local entry is used only as a
 *    best-effort fallback on the brief race window where `pushHooks.open`
 *    has populated the local map but the cluster pub/sub event has not
 *    yet propagated to this instance's index.
 *
 * Returns whatever the client's `onPush(event, handler)` returns.
 *
 * Error surface (all `LiveError` with discriminating `.code`):
 * - `VALIDATION` - bad target / event / options / timeoutMs at the call site.
 * - `NOT_FOUND` - no connection registered for the userId (and no
 *   `remoteRegistry` is configured).
 * - `TIMEOUT` - the recipient did not reply within `timeoutMs`. Wraps
 *   the underlying `'request timed out'` Error from the adapter (and
 *   any remote-registry shape that rejects with the same wording);
 *   message text is preserved verbatim on `.message` and the original
 *   error on `.cause`.
 *
 * Other rejection sources pass through unchanged: a recipient handler
 * that throws (caller-defined error), `Error('connection closed')`
 * from the adapter when the ws closes mid-flight, or any non-timeout
 * error from a configured `remoteRegistry` (e.g. an offline rejection
 * when the user has no active connection cluster-wide).
 *
 * Multi-device users see most-recent-connection-wins routing within
 * each instance, and cluster-wide most-recent-wins via the registry's
 * Redis hash.
 *
 * Requires `svelte-adapter-uws` >= 0.5.0-next.4 for `platform.request`.
 *
 * @param {{ userId: string }} target
 * @param {string} event
 * @param {any} [data]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 *
 * @example
 * ```js
 * // Inside an admin RPC handler:
 * const reply = await live.push(
 *   { userId: 'u-123' },
 *   'confirm-delete',
 *   { itemId: 42 },
 *   { timeoutMs: 30_000 }
 * );
 * if (reply.confirmed) await actuallyDelete(42);
 * ```
 *
 * @example
 * ```js
 * // hooks.ws.js - wire the local registry once:
 * import { pushHooks } from 'svelte-realtime/server';
 * export const open = pushHooks.open;
 * export const close = pushHooks.close;
 * ```
 *
 * @example
 * ```js
 * // For cluster routing, also wire the extensions connection registry:
 * import { createConnectionRegistry } from 'svelte-adapter-uws-extensions/redis/registry';
 * const registry = createConnectionRegistry(redis, { identify: (ws) => ws.getUserData()?.userId });
 * live.configurePush({ remoteRegistry: registry });
 * ```
 */
const _livePush = async function push(target, event, data, options) {
	if (!target || typeof target !== 'object') {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push: target must be an object like { userId }');
	}
	if (typeof event !== 'string' || event.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push: event must be a non-empty string');
	}
	if (options !== undefined && options !== null) {
		if (typeof options !== 'object') {
			throw new LiveError('VALIDATION', '[svelte-realtime] live.push: options must be an object');
		}
		if (options.timeoutMs !== undefined) {
			if (typeof options.timeoutMs !== 'number' || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
				throw new LiveError('VALIDATION', '[svelte-realtime] live.push: options.timeoutMs must be a positive finite number. For fire-and-forget delivery, use `live.notify(target, event, data)` instead.');
			}
		}
	}

	const targetKey = _resolvePushTarget(target, 'live.push');

	// sessionId target: cluster-first when the remoteRegistry exposes
	// requestSession (route to whichever instance owns the session cluster-wide,
	// resume-aware), falling back to the local session entry on the brief
	// registry-offline race after a fresh open - exactly mirroring the userId
	// path below. Without a requestSession-capable registry this stays local-only.
	if (targetKey === 'sessionId') {
		const sessionId = /** @type {any} */ (target).sessionId;
		const localSessionEntry = _pushSessionRegistry.get(sessionId);
		if (_remoteRegistry && typeof _remoteRegistry.requestSession === 'function') {
			try {
				return await _remoteRegistry.requestSession(sessionId, event, data, options || undefined);
			} catch (err) {
				if (!(localSessionEntry && _isRegistryOfflineError(err))) throw _translatePushError(err);
				// fall through to the (fresher) local entry below
			}
		}
		return _localPushRequest(localSessionEntry, event, data, options, 'sessionId', sessionId);
	}

	// topic target: broadcast a request to every subscriber of the topic and
	// aggregate the replies (the request/reply analog of publish). Cluster-wide
	// when a topicBroadcast coordinator is wired, else this worker's subscribers.
	// NOTE: the topic is used verbatim - unlike `ctx.publish`, a connection-less
	// live.push({ topic }) has no ctx and so does NOT auto-apply tenant scoping;
	// a multi-tenant caller must pass an already-tenant-qualified topic.
	if (targetKey === 'topic') {
		return _broadcastTopicRequest(/** @type {any} */ (target).topic, event, data, options);
	}

	const userId = /** @type {any} */ (target).userId;

	// Cluster-first when a remoteRegistry is configured: the registry's
	// userToInstance map is the cluster-wide canonical-owner truth (most-
	// recent open wins per its last-write-wins applyOpenEvent). The
	// registry's own self-targeting short-circuit means no extra Redis
	// hop when the canonical owner is THIS instance -- single-tab perf
	// is unchanged. Multi-tab same-user across instances now routes
	// deterministically to the cluster-canonical recipient regardless of
	// which instance the caller runs on, matching the documented
	// "cluster-wide most-recent-wins" contract above.
	//
	// On a brief registry-offline race (fresh local open whose cluster
	// pub/sub event has not yet propagated to this instance's index),
	// fall back to the local entry so the just-opened user does not see
	// a NOT_FOUND for their own push.
	const localEntry = _pushRegistry.get(userId);
	if (_remoteRegistry) {
		try {
			return await _remoteRegistry.request(userId, event, data, options || undefined);
		} catch (err) {
			if (localEntry && _isRegistryOfflineError(err)) {
				// fall through to local fast path below
			} else {
				throw _translatePushError(err);
			}
		}
	}
	return _localPushRequest(localEntry, event, data, options, 'userId', userId);
};

/**
 * Validate a push/notify target: exactly one known target key
 * (`userId` | `sessionId` | `topic`), no unknown keys, and the chosen id is a
 * non-empty string. Returns the resolved key. `caller` flavors the error
 * messages (`'live.push'` / `'live.notify'`).
 * @param {any} target @param {string} caller
 * @returns {'userId' | 'sessionId' | 'topic'}
 */
function _resolvePushTarget(target, caller) {
	const keys = Object.keys(target);
	const unknown = keys.filter((k) => k !== 'userId' && k !== 'sessionId' && k !== 'topic');
	if (unknown.length > 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] ' + caller + ': unsupported target keys: ' + unknown.join(', '));
	}
	const known = keys.filter((k) => k === 'userId' || k === 'sessionId' || k === 'topic');
	if (known.length !== 1) {
		throw new LiveError('VALIDATION', '[svelte-realtime] ' + caller + ': target must name exactly one of userId / sessionId / topic');
	}
	const key = /** @type {'userId' | 'sessionId' | 'topic'} */ (known[0]);
	const id = target[key];
	if (typeof id !== 'string' || id.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] ' + caller + ': target.' + key + ' must be a non-empty string');
	}
	return key;
}

/**
 * Send a request to a locally-registered connection and map its delivery
 * errors, or throw `NOT_FOUND` when no entry is registered. Shared by the
 * local userId fast path and the (cluster-free) sessionId path.
 * @param {{ ws: any, platform: any } | undefined} entry
 * @param {string} event @param {any} data @param {any} options
 * @param {string} label @param {string} id
 * @returns {Promise<any>}
 */
async function _localPushRequest(entry, event, data, options, label, id) {
	if (entry) {
		if (typeof entry.platform.request !== 'function') {
			throw new Error('[svelte-realtime] live.push: platform.request is not available; requires svelte-adapter-uws >= 0.5.0-next.4');
		}
		try {
			return await entry.platform.request(entry.ws, event, data, options || undefined);
		} catch (err) {
			throw _translatePushError(err);
		}
	}
	throw new LiveError('NOT_FOUND', "no active connection for " + label + " '" + id + "'");
}

/**
 * Cluster coordinators (`platform.topicBroadcast`) whose local-serve handler has
 * been wired. Keyed by the coordinator so a re-wrapped platform that exposes the
 * same coordinator does not double-register the handler.
 * @type {WeakSet<object>}
 */
const _topicBroadcastWired = new WeakSet();

/**
 * Wire a topic-broadcast coordinator's local-serve handler once. The handler
 * runs the adapter's single-instance `platform.requestTopic` over THIS instance's
 * subscribers; the coordinator calls it both for the origin's own subscribers and
 * for inbound peer broadcasts. Reads `state.cronPlatform` live so a re-init that
 * swaps the platform reference still serves through the current one.
 * @param {any} cluster
 */
function _ensureTopicBroadcastWired(cluster) {
	if (!cluster || typeof cluster.onRequest !== 'function' || _topicBroadcastWired.has(cluster)) return;
	_topicBroadcastWired.add(cluster);
	cluster.onRequest((topic, event, data, opts) => {
		const p = state.cronPlatform;
		if (p && typeof p.requestTopic === 'function') return p.requestTopic(topic, event, data, opts);
		return Promise.resolve([]);
	});
}

/**
 * Fold a list of per-subscriber outcomes (`{ ok, reply } | { ok: false, error }`)
 * into the aggregate shape `{ replies, errors, count, delivered }`. Shared by the
 * single-instance and cluster topic paths so both return an identical shape.
 * @param {any[]} results
 */
function _aggregateTopicResults(results) {
	const list = Array.isArray(results) ? results : [];
	const replies = [];
	const errors = [];
	for (const r of list) {
		if (r && r.ok) replies.push(r.reply);
		else errors.push({ message: (r && r.error) ? String(r.error) : 'unknown' });
	}
	return { replies, errors, count: list.length, delivered: replies.length };
}

/**
 * Broadcast a request to every subscriber of `topic` and aggregate the
 * per-subscriber replies. Prefers the cluster coordinator
 * (`platform.topicBroadcast`) when wired - which fans the request across every
 * instance and aggregates cluster-wide - and otherwise falls back to the
 * adapter's single-instance `platform.requestTopic` (this worker's subscribers).
 * Partial-success: a subscriber that times out / errors / closed lands in
 * `errors`, never failing the whole call. Returns
 * `{ replies, errors, count, delivered }`.
 * @param {string} topic @param {string} event @param {any} data @param {any} options
 * @returns {Promise<{ replies: any[], errors: Array<{ message: string }>, count: number, delivered: number }>}
 */
async function _broadcastTopicRequest(topic, event, data, options) {
	const platform = state.cronPlatform;
	const cluster = platform && platform.topicBroadcast;
	let results;
	if (cluster && typeof cluster.broadcast === 'function') {
		_ensureTopicBroadcastWired(cluster);
		try {
			results = await cluster.broadcast(topic, event, data, options || undefined);
		} catch (err) {
			throw _translatePushError(err);
		}
	} else if (platform && typeof platform.requestTopic === 'function') {
		try {
			results = await platform.requestTopic(topic, event, data, options || undefined);
		} catch (err) {
			throw _translatePushError(err);
		}
	} else {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push({ topic }): requires a captured platform with requestTopic (svelte-adapter-uws >= 0.6.0-next.39). Wire `realtime({ ... }).init` from your hooks.ws.js init({ platform }) hook.');
	}
	return _aggregateTopicResults(results);
}

/**
 * Translate a low-level push delivery error into the typed LiveError
 * surface. Today this only catches deadline expiry from the adapter's
 * `platform.request` (`new Error('request timed out')`) and from
 * remote-registry shapes that use the same "timed out" wording, and
 * rethrows as `LiveError('TIMEOUT', ...)` so callers can discriminate
 * via `err.code` instead of substring-matching `err.message`. Other
 * errors (connection-closed, handler-thrown, registry offline, etc.)
 * pass through unchanged so caller-defined error shapes are preserved.
 *
 * Already-typed `LiveError` rejections (e.g. `NOT_FOUND` from a remote
 * registry) also pass through unchanged.
 *
 * Message text is preserved verbatim on the wrapped error so any
 * existing substring callers continue to match while they migrate to
 * the structured code. The original error is attached as `.cause`.
 *
 * @param {unknown} err
 * @returns {unknown}
 */
function _translatePushError(err) {
	if (err instanceof LiveError) return err;
	const msg = err && typeof (/** @type {any} */ (err).message) === 'string'
		? /** @type {any} */ (err).message
		: '';
	if (msg && /timed out/i.test(msg)) {
		const wrapped = new LiveError('TIMEOUT', msg);
		/** @type {any} */ (wrapped).cause = err;
		return wrapped;
	}
	return err;
}

/**
 * Detect the "cluster has no entry for this userId" rejection from a
 * configured remoteRegistry. Used by live.push / live.notify to decide
 * whether to fall back to a (potentially fresher) local registry entry
 * during the brief propagation race after `pushHooks.open` writes to
 * Redis + publishes the event but the subscriber index hasn't yet
 * applied it on the current instance.
 *
 * Conservatively substring-matches "offline" -- the extensions
 * registry's exact wording is `registry.request: target user "..." is
 * offline`, and the project's existing test fixtures throw bare
 * `Error('offline')`. Other cluster errors (recipient handler throw,
 * timeout) are real signals and NOT eligible for local fallback so
 * caller-defined error shapes propagate intact.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function _isRegistryOfflineError(err) {
	const msg = err && typeof (/** @type {any} */ (err).message) === 'string'
		? /** @type {any} */ (err).message
		: '';
	return /offline/i.test(msg);
}

/**
 * Bounded internal timeout for the wire-level request that backs
 * `live.notify`. The caller doesn't await the reply - this only
 * controls how long the adapter's per-request tracker holds the entry
 * before reclaiming it. Long enough that a slow client roundtrip
 * doesn't leak; short enough that the tracker doesn't accumulate stale
 * entries under high notify volume. 1s is a deliberate "small but
 * sufficient" pick - can switch to a true noReply primitive in a
 * future adapter bump without changing the live.notify caller API.
 */
const _NOTIFY_INTERNAL_TIMEOUT_MS = 1000;

/**
 * Send a server-initiated event to a connected user without awaiting a
 * reply. The fire-and-forget counterpart to `live.push`.
 *
 * **When to use which:**
 * - `live.push(target, event, data, { timeoutMs })` - request/reply.
 *   You await a value back from the client's `onPush(event, handler)`.
 *   `timeoutMs` controls how long you wait. Throws on offline user,
 *   timeout, client handler error.
 * - `live.notify(target, event, data)` - fire-and-forget. The client's
 *   `onPush(event, handler)` still fires (same wire path), but the
 *   handler's return value is discarded and the call resolves without
 *   waiting for it. Returns `Promise<void>` that resolves once the
 *   envelope is dispatched. Never rejects in normal operation: an
 *   offline user, a remote-registry failure, a client handler that
 *   throws - all silent. The caller chose `notify` exactly because
 *   they don't want to deal with delivery state.
 *
 * Wire shape is identical to `live.push` today; the difference is
 * caller-side semantics (no await, no error surface). When the
 * adapter ships a true no-reply primitive, the internal implementation
 * swaps without changing this caller API.
 *
 * **Don't use `live.push({ timeoutMs: 0 })` for fire-and-forget.** It
 * throws synchronously (timeoutMs must be positive). Wrapping the
 * throw in `.catch(() => {})` silently swallows it - the push never
 * fires, the recipient never sees anything, no diagnostic anywhere.
 * Use `live.notify` instead.
 *
 * @param {{ userId: string }} target
 * @param {string} event
 * @param {any} [data]
 * @returns {Promise<void>}
 *
 * @example
 * ```js
 * // Inside an upload completion handler:
 * live.notify({ userId: upload.userId }, 'upload:complete', { id: upload.id });
 * // Fire-and-forget. Returns immediately. If the user is offline,
 * // silently drops - they'll see the result on next page load.
 * ```
 *
 * @example
 * ```js
 * // Server-side (cron-driven) progress notifications:
 * for (const userId of activeUsers) {
 *   live.notify({ userId }, 'price:tick', { symbol, price });
 * }
 * // No accumulating timeouts to manage; no `Promise.all` rejection
 * // boundary if some users are offline.
 * ```
 */
const _liveNotify = function notify(target, event, data) {
	if (!target || typeof target !== 'object') {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.notify: target must be an object like { userId }');
	}
	if (typeof event !== 'string' || event.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.notify: event must be a non-empty string');
	}
	const targetKey = _resolvePushTarget(target, 'live.notify');

	// sessionId target: cluster-first fire-and-forget when the remoteRegistry
	// exposes requestSession (route to the session's owning instance cluster-wide),
	// else local delivery. Same silent contract and registry-offline local
	// fallback as the userId notify path below.
	if (targetKey === 'sessionId') {
		const sessionId = /** @type {any} */ (target).sessionId;
		const sessionEntry = _pushSessionRegistry.get(sessionId);
		if (_remoteRegistry && typeof _remoteRegistry.requestSession === 'function') {
			try {
				const p = _remoteRegistry.requestSession(sessionId, event, data, { timeoutMs: _NOTIFY_INTERNAL_TIMEOUT_MS });
				if (sessionEntry) {
					p.catch((err) => { if (_isRegistryOfflineError(err)) _deliverLocalNotify(sessionEntry); });
				} else {
					p.catch(() => { /* silent: fire-and-forget contract */ });
				}
			} catch {
				if (sessionEntry) _deliverLocalNotify(sessionEntry);
			}
			return Promise.resolve();
		}
		if (sessionEntry) _deliverLocalNotify(sessionEntry);
		// Offline + no session entry: silent no-op (fire-and-forget contract).
		return Promise.resolve();
	}

	// topic target: fire-and-forget broadcast to every subscriber of the topic.
	// Same delivery path as live.push({ topic }) but replies are discarded -
	// prefers the cluster coordinator when wired, else the single-instance fan-out.
	if (targetKey === 'topic') {
		const platform = state.cronPlatform;
		const cluster = platform && platform.topicBroadcast;
		try {
			if (cluster && typeof cluster.broadcast === 'function') {
				_ensureTopicBroadcastWired(cluster);
				cluster.broadcast(/** @type {any} */ (target).topic, event, data, { timeoutMs: _NOTIFY_INTERNAL_TIMEOUT_MS })
					.catch(() => { /* discarded by design: notify never surfaces delivery state */ });
			} else if (platform && typeof platform.requestTopic === 'function') {
				platform.requestTopic(/** @type {any} */ (target).topic, event, data, { timeoutMs: _NOTIFY_INTERNAL_TIMEOUT_MS })
					.catch(() => { /* discarded by design: notify never surfaces delivery state */ });
			} else if (_IS_DEV) {
				console.warn('[svelte-realtime] live.notify({ topic }): no topicBroadcast or requestTopic available (requires svelte-adapter-uws >= 0.6.0-next.39); broadcast silently no-op.');
			}
		} catch { /* sync throw on a torn-down platform: silent, fire-and-forget */ }
		return Promise.resolve();
	}

	const userId = /** @type {any} */ (target).userId;

	// Cluster-first when a remoteRegistry is configured -- same rationale
	// as live.push above: the cluster registry's canonical-owner truth
	// routes deterministically to the most-recently-opened ws regardless
	// of caller instance. Self-target short-circuit keeps single-tab perf
	// unchanged. Multi-tab same-user across instances correctly reaches
	// the cluster-canonical recipient instead of the caller-local one.
	//
	// Fire-and-forget contract is preserved: any delivery failure
	// (offline, timeout, client handler throw, remote registry error)
	// is silent. The local fallback on registry-offline is a UX-only
	// optimization for the brief propagation race after a fresh open.
	const localEntry = _pushRegistry.get(userId);
	if (_remoteRegistry) {
		try {
			const p = _remoteRegistry.request(userId, event, data, { timeoutMs: _NOTIFY_INTERNAL_TIMEOUT_MS });
			if (localEntry) {
				// Brief registry-offline race after a fresh local open:
				// the cluster pub/sub event has not yet propagated, the
				// cluster rejects with "is offline", but the local
				// registry already has a valid entry. Fall back so the
				// user does not silently drop their own first notify.
				p.catch((err) => {
					if (_isRegistryOfflineError(err)) _deliverLocalNotify(localEntry);
				});
			} else {
				p.catch(() => { /* silent: fire-and-forget contract */ });
			}
		} catch {
			// Sync throw from registry shape; try local as best-effort.
			if (localEntry) _deliverLocalNotify(localEntry);
		}
		return Promise.resolve();
	}
	if (localEntry) _deliverLocalNotify(localEntry);
	// Offline + no cluster routing: silent no-op. The caller chose
	// notify; "we couldn't reach the user" isn't an error in this
	// contract - they'll see the result next time they load.
	return Promise.resolve();

	function _deliverLocalNotify(entry) {
		if (typeof entry.platform.request !== 'function') {
			// Same versioning constraint as live.push - platform.request
			// requires svelte-adapter-uws >= 0.5.0-next.4. Stay silent in
			// production: notify is fire-and-forget; a missing platform
			// primitive shouldn't surface at the call site as a sync throw.
			if (_IS_DEV) {
				console.warn('[svelte-realtime] live.notify: platform.request is not available; requires svelte-adapter-uws >= 0.5.0-next.4. Notify dispatch silently no-op.\n  See: https://svti.me/migration');
			}
			return;
		}
		try {
			entry.platform.request(entry.ws, event, data, { timeoutMs: _NOTIFY_INTERNAL_TIMEOUT_MS })
				.catch(() => {
					// Discarded by design: notify never surfaces delivery
					// state to the caller. Timeout, client handler error,
					// connection close - all silent.
				});
		} catch {
			// platform.request can throw synchronously on a torn-down ws.
			// Same fire-and-forget contract: silent.
		}
	}
};

/**
 * Reset the push registry, identify config, and remote registry binding.
 * Tests only.
 * @internal
 */
export function _resetPushRegistry() {
	_pushRegistry.clear();
	_pushSessionRegistry.clear();
	state.pushIdentify = null;
	state.pushSessionIdentify = null;
	_remoteRegistry = null;
	_pushRegistryWarnFired = false;
	_pushSessionRegistryWarnFired = false;
}

export function installPush(live) {
	live.configurePush = _liveConfigurePush;
	live.push = _livePush;
	live.notify = _liveNotify;
}
