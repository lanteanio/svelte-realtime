// @ts-check
import { _IS_DEV } from './env.js';
import { _isTenancyEnabled, _resolveTenant, _TENANT_TOPIC_NS } from './tenant.js';

/**
 * The adapter's marker for a hook that never takes the topic decision away from
 * the adapter's own wire-subscribe gate. A registry symbol, shared with the
 * adapter's plugins.
 */
const SIDE_EFFECT_ONLY = Symbol.for('adapter-uws.hook.side-effect-only');

/** The code a tenant-scoped server subscribe fails with when the hooks are not in the subscribe path. */
export const TENANT_GUARD_REQUIRED = 'TENANT_GUARD_REQUIRED';

/**
 * Server-side subscribes of tenant-scoped connections that are waiting for the
 * adapter's subscribe hook chain: socket -> wire topic -> token. The hooks
 * from `realtime()` mark a token when they see its topic, so the subscribe
 * call can tell whether they are in the path.
 * @type {WeakMap<object, Map<string, { ran: boolean }>>}
 */
const _pendingGuards = new WeakMap();

let _warnedGuardMissing = false;

/** The adapter's per-connection subscription registry, a registered slot. */
const WS_SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');

/**
 * Whether the socket already holds `topic`. The adapter answers a subscribe of
 * a held topic without running any hook, and that membership already passed
 * the hooks when it was granted.
 * @param {any} ws
 * @param {string} topic
 */
function _holdsTopic(ws, topic) {
	try {
		const subs = ws.getUserData()?.[WS_SUBSCRIPTIONS];
		if (subs instanceof Set) return subs.has(topic);
		return typeof ws.isSubscribed === 'function' && ws.isSubscribed(topic) === true;
	} catch {
		return false;
	}
}

/**
 * Start a server-side subscribe of `topic` for a tenant-scoped connection.
 * Returns null when the socket already holds the topic: the adapter runs no
 * hook for it, so there is nothing to check.
 * @param {object} ws
 * @param {string} topic
 * @returns {{ ran: boolean } | null}
 */
export function _beginGuardedSubscribe(ws, topic) {
	if (_holdsTopic(ws, topic)) return null;
	let byTopic = _pendingGuards.get(ws);
	if (!byTopic) { byTopic = new Map(); _pendingGuards.set(ws, byTopic); }
	const existing = byTopic.get(topic);
	if (existing) return existing;
	const token = { ran: false };
	byTopic.set(topic, token);
	return token;
}

/**
 * End a server-side subscribe started with `_beginGuardedSubscribe`. Returns
 * the refusal code when the subscribe was admitted (`denial` is empty) but the
 * hooks from `realtime()` never saw the topic; a subscribe the adapter refused
 * on its own is not judged.
 * @param {object} ws
 * @param {string} topic
 * @param {{ ran: boolean }} token
 * @param {unknown} denial - what the adapter's subscribe returned
 * @returns {string | null}
 */
export function _endGuardedSubscribe(ws, topic, token, denial) {
	_cancelGuardedSubscribe(ws, topic, token);
	if (token.ran || denial) return null;
	if (!_warnedGuardMissing) {
		_warnedGuardMissing = true;
		console.warn(
			'[svelte-realtime] Tenant-scoped subscribe refused: the subscribe hooks from realtime() are not in the subscribe path. ' +
			'Export subscribe and subscribeBatch from the realtime() result in src/hooks.ws.js and pass your own ' +
			'gate as realtime({ subscribe }), which then receives the logical topic and ctx.tenantId.'
		);
	}
	return TENANT_GUARD_REQUIRED;
}

/**
 * Drop a pending server-side subscribe whose call failed, without judging it.
 * @param {object} ws
 * @param {string} topic
 * @param {{ ran: boolean }} token
 */
export function _cancelGuardedSubscribe(ws, topic, token) {
	const byTopic = _pendingGuards.get(ws);
	if (byTopic && byTopic.get(topic) === token) {
		byTopic.delete(topic);
		if (byTopic.size === 0) _pendingGuards.delete(ws);
	}
}

/**
 * Refuse a server-side subscribe the hooks never saw: undo the membership the
 * adapter already granted. Synchronous, so it runs before the caller ends the
 * delivery admission and no frame on the topic is released to the socket.
 * @param {any} platform
 * @param {any} ws
 * @param {string} topic
 */
export function _undoUnguardedSubscribe(platform, ws, topic) {
	try {
		if (platform && typeof platform.unsubscribe === 'function') platform.unsubscribe(ws, topic);
		else if (ws && typeof ws.unsubscribe === 'function') ws.unsubscribe(topic);
	} catch { /* a closed socket holds no membership */ }
}

/** The client-facing message of a `TENANT_GUARD_REQUIRED` refusal; the server-side warning names the fix. */
export const TENANT_GUARD_CLIENT_MESSAGE = 'Subscribe refused: the server does not route subscribes through its tenant hooks';

/** @param {object} ws @param {string} topic */
function _markGuarded(ws, topic) {
	const token = _pendingGuards.get(ws)?.get(topic);
	if (token) token.ran = true;
}

/**
 * The connection's tenant: an id, null when untenanted, or undefined when the
 * resolver failed (every topic is then refused).
 * @param {any} ws
 * @returns {string | null | undefined}
 */
function _connectionTenant(ws) {
	if (!_isTenancyEnabled()) return null;
	try { return _resolveTenant(ws.getUserData()); }
	catch { return undefined; }
}

/**
 * Scope a requested wire topic to the connection. A tenant-scoped topic of the
 * connection's own tenant yields its logical topic; one of another tenant, or
 * any tenant-scoped topic of an untenanted connection, is refused. Any other
 * topic is returned as is.
 * @param {any} ws
 * @param {string} topic
 * @param {string | null | undefined} [tenantId] - the connection's tenant, when already resolved
 * @returns {{ denial: string } | { denial: null, logical: string, tenantId: string | null }}
 */
function _scopeTopic(ws, topic, tenantId = _connectionTenant(ws)) {
	if (tenantId === undefined) return { denial: 'FORBIDDEN' };
	if (typeof topic === 'string' && topic.startsWith(_TENANT_TOPIC_NS)) {
		if (tenantId === null) return { denial: 'FORBIDDEN' };
		const own = _TENANT_TOPIC_NS + tenantId + '/';
		if (!topic.startsWith(own)) return { denial: 'FORBIDDEN' };
		return { denial: null, logical: topic.slice(own.length), tenantId };
	}
	return { denial: null, logical: topic, tenantId };
}

/**
 * The decision the `subscribe` hook from `realtime()` takes before any
 * application gate, synchronously: a refusal reason, or null after recording
 * that the topic passed the hooks. For harnesses that stand in for the adapter.
 * @param {any} ws
 * @param {string} topic
 * @returns {string | null}
 */
export function _scopeSubscribe(ws, topic) {
	const scoped = _scopeTopic(ws, topic);
	if (scoped.denial !== null) return scoped.denial;
	_markGuarded(ws, topic);
	return null;
}

/**
 * Build the `subscribe` hook `realtime()` returns, and a `subscribeBatch` hook
 * when the application passes a batch gate. Each refuses a tenant-scoped topic
 * outside the connection's own tenant before any application gate runs, then
 * hands the application's gate the logical topic in the same argument
 * position, with the tenant on `ctx.tenantId`. Without an application gate the
 * hook is marked as a side effect, so the adapter's own wire-subscribe gate
 * keeps deciding.
 * @param {((ws: any, topic: string, ctx: any) => any) | undefined} appSubscribe
 * @param {((ws: any, topics: string[], ctx: any) => any) | undefined} appSubscribeBatch
 */
export function _createSubscribeHooks(appSubscribe, appSubscribeBatch) {
	if (appSubscribe !== undefined && typeof appSubscribe !== 'function') {
		throw new Error('[svelte-realtime] realtime({ subscribe }): must be a function (ws, topic, ctx) => boolean | string | void');
	}
	if (appSubscribeBatch !== undefined && typeof appSubscribeBatch !== 'function') {
		throw new Error('[svelte-realtime] realtime({ subscribeBatch }): must be a function (ws, topics, ctx) => Record<string, boolean | string>');
	}

	// The gate also gets the wire topic: a plugin hook it calls, such as a
	// presence or cursor hook that keys its state by topic, needs the
	// tenant-scoped one.
	/** @param {any} ctx @param {string | null} tenantId @param {object} wire */
	const gateCtx = (ctx, tenantId, wire) => Object.assign({}, ctx, { tenantId }, wire);

	/**
	 * @param {any} ws
	 * @param {string} topic
	 * @param {any} ctx
	 */
	async function subscribe(ws, topic, ctx) {
		const scoped = _scopeTopic(ws, topic);
		if (scoped.denial !== null) return scoped.denial;
		_markGuarded(ws, topic);
		if (appSubscribe) return appSubscribe(ws, scoped.logical, gateCtx(ctx, scoped.tenantId, { wireTopic: topic }));
		if (appSubscribeBatch) {
			const result = await appSubscribeBatch(ws, [scoped.logical], gateCtx(ctx, scoped.tenantId, { wireTopics: [topic] }));
			const value = result && typeof result === 'object' ? result[scoped.logical] : undefined;
			return value === false || typeof value === 'string' ? value : undefined;
		}
		return undefined;
	}

	/**
	 * @param {any} ws
	 * @param {string[]} topics
	 * @param {any} ctx
	 */
	async function subscribeBatch(ws, topics, ctx) {
		/** @type {Record<string, string | boolean>} */
		const result = Object.create(null);
		/** @type {string[]} */
		const logicals = [];
		/** @type {string[]} */
		const wires = [];
		const connectionTenant = _connectionTenant(ws);
		let tenantId = null;
		for (const topic of topics) {
			const scoped = _scopeTopic(ws, topic, connectionTenant);
			if (scoped.denial !== null) { result[topic] = scoped.denial; continue; }
			_markGuarded(ws, topic);
			tenantId = scoped.tenantId;
			logicals.push(scoped.logical);
			wires.push(topic);
		}
		if (logicals.length === 0) return result;
		const answer = await /** @type {(ws: any, topics: string[], ctx: any) => any} */ (appSubscribeBatch)(ws, logicals, gateCtx(ctx, tenantId, { wireTopics: wires }));
		if (!answer || typeof answer !== 'object') return result;
		for (let i = 0; i < logicals.length; i++) {
			const value = answer[logicals[i]];
			if (value === false || typeof value === 'string') result[wires[i]] = value;
		}
		return result;
	}

	if (!appSubscribe && !appSubscribeBatch) /** @type {any} */ (subscribe)[SIDE_EFFECT_ONLY] = true;
	// The adapter routes every subscribe through an exported batch hook. Only
	// an application batch gate gets one, so an application `subscribe` placed
	// beside the realtime() hooks is never shadowed by a batch hook it did not
	// write.
	return { subscribe, subscribeBatch: appSubscribeBatch ? subscribeBatch : undefined };
}
