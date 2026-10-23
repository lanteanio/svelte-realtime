// @ts-check
//
// Per-recipient delivery authorization. realtime({ authorizeDelivery })
// installs one adapter policy per worker (platform.authorizeDelivery) and
// translates each outbound frame into a realtime descriptor: stream topics
// gain the admitting RPC path and its validated arguments, stream snapshots
// and replay carried inside RPC responses are checked against their stream
// topic, and framework responses addressed to one socket (RPC, upload and
// protocol frames) pass because their own guards already ran.
//
// The application's answer is returned to the adapter unchanged, so a
// synchronous answer keeps the frame inline and a promise holds it; the
// adapter owns ordering, bounds, close codes and diagnostics.
import { _buildCtx, _getCtxHelpers } from './ctx.js';

/** @type {WeakMap<object, Map<string, { rpc: string, args: readonly unknown[] }>>} */
const subscriptions = new WeakMap();
/** @type {WeakSet<object>} */
const configured = new WeakSet();
/** Whether any platform in this process installed a policy; keeps the subscribe path free otherwise. */
let anyConfigured = false;

/**
 * Framework response channels addressed to a single socket. Their payloads
 * answer a request that already passed its RPC or upload guard.
 */
const RESPONSE_TOPICS = new Set(['__rpc', '__upload', '__realtime']);

/**
 * Freeze a cloned argument tuple so every policy call sees the admitted
 * values. Typed arrays cannot be frozen; their copy is still private.
 * @param {any} value
 */
function _freezeDeep(value) {
	if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Reflect.ownKeys(value)) _freezeDeep(value[key]);
	return value;
}

/**
 * Validate the realtime() options when they are written, before any worker
 * starts.
 * @param {unknown} authorize
 * @param {unknown} options
 */
export function validateDeliveryAuthorizationConfig(authorize, options) {
	if (authorize === undefined) {
		if (options !== undefined) {
			throw new Error('[svelte-realtime] realtime({ deliveryAuthorizationOptions }): requires realtime({ authorizeDelivery })');
		}
		return;
	}
	if (typeof authorize !== 'function') {
		throw new TypeError('[svelte-realtime] realtime({ authorizeDelivery }): must be a function');
	}
	if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
		throw new TypeError('[svelte-realtime] realtime({ deliveryAuthorizationOptions }): must be an object');
	}
}

/**
 * Record which stream RPC admitted a topic on a socket. Kept only when the
 * socket's platform installed a delivery policy.
 * @param {object} ws @param {object} platform @param {string} topic @param {string} rpc @param {any[]} args
 */
export function rememberDeliverySubscription(ws, platform, topic, rpc, args) {
	if (!anyConfigured) return;
	let owner = platform;
	while (owner && !configured.has(owner)) owner = Object.getPrototypeOf(owner);
	if (!owner) return;
	let topics = subscriptions.get(ws);
	if (!topics) { topics = new Map(); subscriptions.set(ws, topics); }
	// Own the argument tuple: loaders may mutate their input after admission.
	if (!topics.has(topic)) topics.set(topic, { rpc, args: _freezeDeep(structuredClone(Array.isArray(args) ? args : [])) });
}

/** @param {object} ws @param {string} [topic] */
export function forgetDeliverySubscription(ws, topic) {
	if (topic === undefined) subscriptions.delete(ws);
	else subscriptions.get(ws)?.delete(topic);
}

/** @param {unknown} value */
function _isThenable(value) {
	return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (/** @type {any} */ (value).then) === 'function';
}

/**
 * Ask the policy about each reply in order. Returns the first answer that is
 * not literally true, so the adapter can tell a denial from an invalid
 * answer, or true; a promise from the first pending answer on.
 * @param {(reply: any) => unknown} decide
 * @param {any[]} replies
 * @param {number} from
 * @returns {unknown}
 */
function _every(decide, replies, from) {
	for (let i = from; i < replies.length; i++) {
		const answer = decide(replies[i]);
		if (_isThenable(answer)) {
			return Promise.resolve(answer).then((settled) => settled === true ? _every(decide, replies, i + 1) : settled);
		}
		if (answer !== true) return answer;
	}
	return true;
}

/** @param {any} reply */
function _isStreamReply(reply) {
	return reply !== null && typeof reply === 'object' && reply.ok === true && reply.attach !== true && typeof reply.topic === 'string';
}

/**
 * Install the adapter's per-recipient delivery gate. Refuses an adapter
 * without the capability instead of falling back to a publish wrapper that
 * would miss worker relay, replay and queued frames.
 * @param {any} platform
 * @param {(ctx: any, delivery: any) => unknown} authorize
 * @param {any} options
 */
export function installDeliveryAuthorization(platform, authorize, options) {
	validateDeliveryAuthorizationConfig(authorize, options);
	if (typeof platform?.authorizeDelivery !== 'function') {
		throw new Error(
			'[svelte-realtime] realtime({ authorizeDelivery }): the installed svelte-adapter-uws has no platform.authorizeDelivery. ' +
			'Upgrade svelte-adapter-uws to 0.6.0-next.97 or newer, or remove authorizeDelivery.'
		);
	}
	const helpers = _getCtxHelpers(platform);
	platform.authorizeDelivery((/** @type {any} */ ws, /** @type {any} */ frame) => {
		const kind = frame.kind;
		const topic = frame.topic;
		if (kind === 'message' && RESPONSE_TOPICS.has(topic)) {
			// Stream snapshots and replay travel inside RPC responses. Check
			// them against their stream; every other response is admitted.
			if (topic !== '__rpc' || frame.binary) return true;
			const data = frame.data;
			const replies = data !== null && typeof data === 'object' && Array.isArray(data.batch) ? data.batch : [data];
			if (!replies.some(_isStreamReply)) return true;
			const ctx = _buildCtx(ws.getUserData(), ws, platform, helpers, null);
			const topics = subscriptions.get(ws);
			return _every((reply) => {
				if (!_isStreamReply(reply)) return true;
				const source = topics?.get(reply.topic);
				return authorize(ctx, Object.freeze({
					kind: reply.replay === true ? 'replay' : 'snapshot',
					topic: reply.topic, event: null, data: reply.data, binary: false,
					rpc: source?.rpc ?? null, args: source?.args ?? null
				}));
			}, replies, 0);
		}
		// A request is addressed to one socket and carries no topic.
		const named = typeof topic === 'string' ? topic : null;
		const source = named === null ? undefined : subscriptions.get(ws)?.get(named);
		const ctx = _buildCtx(ws.getUserData(), ws, platform, helpers, null);
		return authorize(ctx, Object.freeze({
			kind, topic: named, event: frame.event ?? null, data: frame.data, binary: frame.binary === true,
			rpc: source?.rpc ?? null, args: source?.args ?? null
		}));
	}, options);
	configured.add(platform);
	anyConfigured = true;
}
