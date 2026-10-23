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
import { formatDiagnostic } from '../shared/diagnostic.js';

/**
 * @typedef {{ rpc: string, args: readonly unknown[], copy: boolean }} Admission
 * @typedef {{ live: Map<string, Admission>, retired: Map<string, Admission> }} SocketAdmissions
 */

/** @type {WeakMap<object, SocketAdmissions>} */
const subscriptions = new WeakMap();
/** @type {WeakSet<object>} */
const configured = new WeakSet();
/** Whether a policy is configured or installed in this process; keeps every other path free. */
let anyConfigured = false;
/** @type {{ authorize: (ctx: any, delivery: any) => unknown, options: any } | null} */
let pending = null;
/** @type {WeakSet<object>} */
const unavailableReported = new WeakSet();

/**
 * Admissions kept per socket after their stream left. The adapter decides a
 * held frame when it reaches the head of the socket's queue, which can be
 * after the unsubscribe that retired its stream; the frame keeps its
 * attribution. Oldest retirements go first.
 */
const RETIRED_PER_SOCKET = 64;

/**
 * Framework response channels addressed to a single socket. Their payloads
 * answer a request that already passed its RPC or upload guard.
 */
const RESPONSE_TOPICS = new Set(['__rpc', '__upload', '__realtime']);

/**
 * Copy a value without invoking accessors. Functions and symbols are kept by
 * reference; cycles are preserved. Marks `state.mutable` when the copy holds
 * values freezing cannot protect (Map, Set, Date, binary data).
 * @param {any} value
 * @param {Map<any, any>} seen
 * @param {{ mutable: boolean }} state
 * @returns {any}
 */
function _copy(value, seen, state) {
	if (value === null || typeof value !== 'object') return value;
	const known = seen.get(value);
	if (known !== undefined) return known;
	if (ArrayBuffer.isView(value)) {
		state.mutable = true;
		const copy = value instanceof DataView
			? new DataView(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer)
			: typeof Buffer === 'function' && Buffer.isBuffer(value) ? Buffer.from(value)
				: new (/** @type {any} */ (value).constructor)(value);
		seen.set(value, copy);
		return copy;
	}
	if (value instanceof ArrayBuffer) {
		state.mutable = true;
		const copy = value.slice(0);
		seen.set(value, copy);
		return copy;
	}
	if (value instanceof Date) {
		state.mutable = true;
		const copy = new Date(value.getTime()); // determinism-allow: copies an existing instant, reads no clock
		seen.set(value, copy);
		return copy;
	}
	if (value instanceof Map) {
		state.mutable = true;
		const copy = new Map();
		seen.set(value, copy);
		for (const [k, v] of value) copy.set(_copy(k, seen, state), _copy(v, seen, state));
		return copy;
	}
	if (value instanceof Set) {
		state.mutable = true;
		const copy = new Set();
		seen.set(value, copy);
		for (const v of value) copy.add(_copy(v, seen, state));
		return copy;
	}
	const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	seen.set(value, copy);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && descriptor.enumerable && 'value' in descriptor) copy[key] = _copy(descriptor.value, seen, state);
	}
	return copy;
}

/** @param {any} value */
function _freezeDeep(value) {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Reflect.ownKeys(value)) _freezeDeep(value[key]);
	return value;
}

/**
 * Own an admitted argument tuple: loaders may mutate their input after
 * admission. Plain data is frozen once and shared by every policy call;
 * values freezing cannot protect are copied again for each call.
 * @param {unknown} args
 * @returns {{ args: readonly unknown[], copy: boolean }}
 */
function _admit(args) {
	const state = { mutable: false };
	const owned = _copy(Array.isArray(args) ? args : [], new Map(), state);
	return state.mutable ? { args: owned, copy: true } : { args: _freezeDeep(owned), copy: false };
}

/** @param {Admission | undefined} admission */
function _argsFor(admission) {
	if (admission === undefined) return null;
	return admission.copy ? _copy(admission.args, new Map(), { mutable: false }) : admission.args;
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
 * Record the realtime() policy so every capture point can install it on the
 * worker's platform, whether or not the app exports the init hook.
 * @param {unknown} authorize
 * @param {unknown} options
 */
export function configureDeliveryAuthorization(authorize, options) {
	validateDeliveryAuthorizationConfig(authorize, options);
	if (authorize === undefined) { pending = null; return; }
	pending = { authorize: /** @type {any} */ (authorize), options };
	anyConfigured = true;
}

/** @param {any} platform */
function _isInstalled(platform) {
	for (let owner = platform; owner; owner = Object.getPrototypeOf(owner)) if (configured.has(owner)) return true;
	return false;
}

/**
 * The adapter hands hooks a per-connection view inheriting from the worker
 * platform; install on that base so the policy's ctx.platform is the base.
 * @param {any} platform
 */
function _base(platform) {
	const proto = Object.getPrototypeOf(platform);
	return proto && proto !== Object.prototype && typeof proto.authorizeDelivery === 'function' ? proto : platform;
}

/**
 * Install the configured policy on this platform unless it already has it.
 * Throws when the adapter lacks the capability.
 * @param {any} platform
 */
export function ensureDeliveryAuthorization(platform) {
	if (pending === null || !platform || _isInstalled(platform)) return;
	installDeliveryAuthorization(_base(platform), pending.authorize, pending.options);
}

/**
 * Connection-level capture point for apps that do not export the init hook:
 * install the policy, or end the connection with 1011 before realtime
 * serves it when the policy cannot be installed.
 * @param {any} ws
 * @param {any} platform
 * @returns {boolean} whether the connection may be served
 */
export function guardDeliveryAuthorization(ws, platform) {
	if (pending === null) return true;
	try {
		ensureDeliveryAuthorization(platform);
		return true;
	} catch (error) {
		const base = platform ? _base(platform) : null;
		if (base && !unavailableReported.has(base)) {
			unavailableReported.add(base);
			console.error(formatDiagnostic({
				source: 'svelte-realtime',
				component: 'server.delivery-authorization',
				event: 'delivery-authorization.unavailable',
				severity: 'error',
				message: 'A delivery policy is configured but could not be installed; connections are closed.',
				attributes: { closeCode: 1011, error: error instanceof Error ? error.message : String(error) }
			}));
		}
		try { ws.end(1011, 'Delivery authorization unavailable'); } catch {}
		return false;
	}
}

/**
 * Record which stream RPC admitted a topic on a socket, while a policy is
 * configured. The first admission of a topic names it until the socket
 * leaves the topic. Returns whether this call recorded it.
 * @param {object} ws @param {object} _platform @param {string} topic @param {string} rpc @param {any[]} args
 * @returns {boolean}
 */
export function rememberDeliverySubscription(ws, _platform, topic, rpc, args) {
	if (!anyConfigured) return false;
	let admissions = subscriptions.get(ws);
	if (!admissions) { admissions = { live: new Map(), retired: new Map() }; subscriptions.set(ws, admissions); }
	if (admissions.live.has(topic)) return false;
	admissions.retired.delete(topic);
	const { args: owned, copy } = _admit(args);
	admissions.live.set(topic, { rpc, args: owned, copy });
	return true;
}

/**
 * Retire a topic's admission (kept for frames still held), or drop every
 * admission of a closed socket.
 * @param {object} ws @param {string} [topic]
 */
export function forgetDeliverySubscription(ws, topic) {
	if (!anyConfigured) return;
	if (topic === undefined) { subscriptions.delete(ws); return; }
	const admissions = subscriptions.get(ws);
	const admission = admissions?.live.get(topic);
	if (!admissions || admission === undefined) return;
	admissions.live.delete(topic);
	admissions.retired.delete(topic);
	admissions.retired.set(topic, admission);
	if (admissions.retired.size > RETIRED_PER_SOCKET) admissions.retired.delete(admissions.retired.keys().next().value);
}

/** @param {object} ws @param {string} topic */
function _admissionOf(ws, topic) {
	const admissions = subscriptions.get(ws);
	return admissions === undefined ? undefined : admissions.live.get(topic) ?? admissions.retired.get(topic);
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
			return _every((reply) => {
				if (!_isStreamReply(reply)) return true;
				const source = _admissionOf(ws, reply.topic);
				return authorize(ctx, Object.freeze({
					kind: reply.replay === true ? 'replay' : 'snapshot',
					topic: reply.topic, event: null, data: reply.data, binary: false,
					rpc: source?.rpc ?? null, args: _argsFor(source)
				}));
			}, replies, 0);
		}
		// A request is addressed to one socket and carries no topic.
		const named = typeof topic === 'string' ? topic : null;
		const source = named === null ? undefined : _admissionOf(ws, named);
		const ctx = _buildCtx(ws.getUserData(), ws, platform, helpers, null);
		return authorize(ctx, Object.freeze({
			kind, topic: named, event: frame.event ?? null, data: frame.data, binary: frame.binary === true,
			rpc: source?.rpc ?? null, args: _argsFor(source)
		}));
	}, options);
	configured.add(platform);
	anyConfigured = true;
}
