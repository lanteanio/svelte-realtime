// @ts-check
import { LiveError } from './live-error.js';
import { assert } from '../shared/assert.js';
import { _validUserIdReason, _MAX_USER_ID_LENGTH } from './validate.js';
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

/** One-shot flag for the MAX_PUSH_REGISTRY warning. Reset by `_resetPushRegistry`. */
let _pushRegistryWarnFired = false;

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

function _getPushIdentify() {
	return state.pushIdentify || _defaultPushIdentify;
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
 * - `remoteRegistry` - an object with a
 *   `request(userId, event, data, options)` method. When supplied,
 *   `live.push({ userId })` falls back to `remoteRegistry.request(...)`
 *   if the userId is not registered on this instance, enabling
 *   cluster-routed push. Pass `null` to clear.
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
 * @param {{ identify?: ((ws: any) => string | null | undefined) | null, remoteRegistry?: { request: Function } | null } | null} config
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
		_remoteRegistry = null;
		return;
	}
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] live.configurePush: config must be an object or null');
	}
	if (config.identify === undefined && config.remoteRegistry === undefined) {
		throw new Error('[svelte-realtime] live.configurePush: config must include at least one of identify or remoteRegistry');
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
		const userId = _getPushIdentify()(ws);
		if (userId == null || userId === '') return;
		const reason = _validUserIdReason(userId);
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
			return;
		}
		_pushRegistry.set(userId, { ws, platform: ctx.platform });
		_wsToPushUserId.set(ws, userId);
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
		// push registry only. The stream-subscription bookkeeping path
		// requires `ctx.platform` for `__onUnsubscribe` callbacks; without
		// it, the safe behavior is "do what the original signature did."
		const userId = _wsToPushUserId.get(ws);
		if (userId == null) return;
		_wsToPushUserId.delete(ws);
		const entry = _pushRegistry.get(userId);
		// push-registry invariant: if userId was tracked in _wsToPushUserId,
		// the registry should still have an entry for that userId (possibly
		// pointing at a different ws if the user reconnected on another
		// device). Missing entry means an external mutation cleared it.
		assert(entry !== undefined, 'realtime/push-registry.entry-tracked', { userIdLen: userId.length });
		if (entry && entry.ws === ws) _pushRegistry.delete(userId);
	}
};

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

	const targetKeys = Object.keys(target);
	const extraKeys = targetKeys.filter((k) => k !== 'userId');
	if (extraKeys.length > 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push: unsupported target keys: ' + extraKeys.join(', '));
	}
	const userId = /** @type {any} */ (target).userId;
	if (typeof userId !== 'string' || userId.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.push: target.userId must be a non-empty string');
	}

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
	if (localEntry) {
		if (typeof localEntry.platform.request !== 'function') {
			throw new Error('[svelte-realtime] live.push: platform.request is not available; requires svelte-adapter-uws >= 0.5.0-next.4');
		}
		try {
			return await localEntry.platform.request(localEntry.ws, event, data, options || undefined);
		} catch (err) {
			throw _translatePushError(err);
		}
	}
	throw new LiveError('NOT_FOUND', "no active connection for userId '" + userId + "'");
};

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
	const targetKeys = Object.keys(target);
	const extraKeys = targetKeys.filter((k) => k !== 'userId');
	if (extraKeys.length > 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.notify: unsupported target keys: ' + extraKeys.join(', '));
	}
	const userId = /** @type {any} */ (target).userId;
	if (typeof userId !== 'string' || userId.length === 0) {
		throw new LiveError('VALIDATION', '[svelte-realtime] live.notify: target.userId must be a non-empty string');
	}

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
	state.pushIdentify = null;
	_remoteRegistry = null;
	_pushRegistryWarnFired = false;
}

export function installPush(live) {
	live.configurePush = _liveConfigurePush;
	live.push = _livePush;
	live.notify = _liveNotify;
}
