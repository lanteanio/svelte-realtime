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
 * @typedef {{ rpc: string, args: readonly unknown[], copy: boolean, confirmed: boolean, token: object | null }} Admission
 * @typedef {{ live: Map<string, Admission>, retired: Map<string, Admission>, inflight: Map<string, number> }} SocketAdmissions
 * @typedef {{ authorize: (ctx: any, delivery: any) => unknown, options: any, retired: boolean }} DeliveryPolicy
 * @typedef {{ options: any }} Installation
 */

/** @type {WeakMap<object, SocketAdmissions>} */
const subscriptions = new WeakMap();
/** Installation per platform object the policy was installed on. @type {WeakMap<object, Installation>} */
const installations = new WeakMap();
/** Installed owner found for a connection-level platform view, so hooks skip the walk. @type {WeakMap<object, object>} */
const resolved = new WeakMap();
/** Whether a policy is configured or installed in this process; keeps every other path free. */
let anyConfigured = false;
/**
 * The policy record whose hooks the adapter ran last. Installed platforms
 * call it through a stable trampoline, so a reloaded hooks.ws takes over in
 * place once the adapter runs its hooks. This assumes one instance of this
 * module per process (one realtime module graph); a second copy would keep
 * its own active record and could not reach a platform the first installed.
 * @type {DeliveryPolicy | null}
 */
let activePolicy = null;
/** Platforms that already logged each diagnostic. @type {WeakSet<object>} */
const reportedUnavailable = new WeakSet();
/** @type {WeakSet<object>} */
const reportedUnguarded = new WeakSet();
/** @type {WeakSet<object>} */
const reportedStale = new WeakSet();

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

/** @param {any} value */
function _isPlain(value) {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Copy admitted arguments without invoking accessors. Arrays and plain
 * objects are copied with their own enumerable data properties (defined, so
 * a `__proto__` key stays a key); Map, Set, Date and binary values are copied
 * and mark `state.mutable`, because freezing cannot protect them. Functions,
 * symbols and other class instances are kept by reference. Cycles are kept.
 * @param {any} value
 * @param {Map<any, any>} seen
 * @param {{ mutable: boolean }} state
 * @returns {any}
 */
function _copy(value, seen, state) {
	if (value === null || typeof value !== 'object') return value;
	const known = seen.get(value);
	if (known !== undefined) return known;
	let copy;
	if (Array.isArray(value)) copy = [];
	else if (_isPlain(value)) copy = Object.create(Object.getPrototypeOf(value));
	else if (ArrayBuffer.isView(value)) {
		state.mutable = true;
		copy = value instanceof DataView
			? new DataView(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer)
			: typeof Buffer === 'function' && Buffer.isBuffer(value) ? Buffer.from(value)
				: new (/** @type {any} */ (value).constructor)(value);
		seen.set(value, copy);
		return copy;
	} else if (value instanceof ArrayBuffer) {
		state.mutable = true;
		copy = value.slice(0);
		seen.set(value, copy);
		return copy;
	} else if (value instanceof Date) {
		state.mutable = true;
		copy = new Date(value.getTime()); // determinism-allow: copies an existing instant, reads no clock
		seen.set(value, copy);
		return copy;
	} else if (value instanceof Map) {
		state.mutable = true;
		copy = new Map();
		seen.set(value, copy);
		for (const [k, v] of value) copy.set(_copy(k, seen, state), _copy(v, seen, state));
		return copy;
	} else if (value instanceof Set) {
		state.mutable = true;
		copy = new Set();
		seen.set(value, copy);
		for (const v of value) copy.add(_copy(v, seen, state));
		return copy;
	} else return value;
	seen.set(value, copy);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) continue;
		Object.defineProperty(copy, key, { value: _copy(descriptor.value, seen, state), enumerable: true, writable: true, configurable: true });
	}
	return copy;
}

/** Freeze copied arrays and plain objects; values kept by reference stay the app's. @param {any} value */
function _freezeDeep(value) {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	if (!Array.isArray(value) && !_isPlain(value)) return value;
	Object.freeze(value);
	for (const key of Reflect.ownKeys(value)) _freezeDeep(value[key]);
	return value;
}

/**
 * Own an admitted argument tuple: loaders may mutate their input after
 * admission. Plain data is frozen once and shared by every policy call;
 * values freezing cannot protect are copied again when a call reads them.
 * @param {unknown} args
 * @returns {{ args: readonly unknown[], copy: boolean }}
 */
function _admit(args) {
	const state = { mutable: false };
	const owned = _copy(Array.isArray(args) ? args : [], new Map(), state);
	return state.mutable ? { args: owned, copy: true } : { args: _freezeDeep(owned), copy: false };
}

/**
 * The frozen descriptor a policy call receives. Arguments that need a fresh
 * copy are copied once, on first read.
 * @param {Record<string, unknown>} fields
 * @param {Admission | undefined} source
 */
function _descriptor(fields, source) {
	const delivery = /** @type {any} */ (fields);
	delivery.rpc = source?.rpc ?? null;
	if (source === undefined || !source.copy) {
		delivery.args = source?.args ?? null;
	} else {
		/** @type {any} */
		let copy;
		Object.defineProperty(delivery, 'args', {
			enumerable: true,
			get() { return copy ??= _copy(source.args, new Map(), { mutable: false }); }
		});
	}
	return Object.freeze(delivery);
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

/** @param {any} a @param {any} b */
function _sameOptions(a, b) {
	if (a === b) return true;
	const left = Object.entries(a ?? {}), right = b ?? {};
	return left.length === Object.keys(right).length && left.every(([key, value]) => Object.is(right[key], value));
}

/**
 * Validate the policy of one realtime() call and return its own record, or
 * null without one. Creating a record never changes the active policy; the
 * hooks of the call activate it when the adapter runs them.
 * @param {unknown} authorize
 * @param {unknown} options
 * @returns {DeliveryPolicy | null}
 */
export function configureDeliveryAuthorization(authorize, options) {
	validateDeliveryAuthorizationConfig(authorize, options);
	if (authorize === undefined) return null;
	anyConfigured = true;
	return { authorize: /** @type {any} */ (authorize), options: _ownOptions(options), retired: false };
}

/** @param {any} options */
function _ownOptions(options) {
	return options === undefined ? undefined : { ...options };
}

/** Records with the same function and equal options are one policy. @param {DeliveryPolicy} a @param {DeliveryPolicy} b */
function _samePolicy(a, b) {
	return a === b || (a.authorize === b.authorize && _sameOptions(a.options, b.options));
}

/** The active policy's function, read once per frame. */
const _activeAuthorize = () => /** @type {DeliveryPolicy} */ (activePolicy).authorize;

/**
 * The platform object that owns `authorizeDelivery`: the adapter hands hooks
 * a per-connection view inheriting from it.
 * @param {any} platform
 */
function _owner(platform) {
	for (let owner = platform; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
		if (Object.prototype.hasOwnProperty.call(owner, 'authorizeDelivery')) return owner;
	}
	return platform;
}

/** @param {any} platform @returns {Installation | undefined} */
function _installationOf(platform) {
	const known = resolved.get(platform);
	if (known !== undefined) {
		const found = installations.get(known);
		if (found !== undefined) return found;
	}
	for (let owner = platform; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
		const found = installations.get(owner);
		if (found !== undefined) { resolved.set(platform, owner); return found; }
	}
	return undefined;
}

/**
 * Forget an installation made by an init that then failed: the adapter drops
 * the policy of a failed init before retrying it, so the retry installs again.
 * @param {any} platform
 */
export function abandonDeliveryAuthorization(platform) {
	installations.delete(_owner(platform));
}

/** Raised for the hooks of a record a newer policy replaced. */
class StalePolicyError extends Error {}

/**
 * Make a record the active policy, because the adapter ran its hooks, and
 * install the bridge on this platform unless it already has it. Activation
 * is one-way: the record it replaces is retired for good, and a retired
 * record's hooks are refused. A record equal to the active one (same
 * function, equal options) is the same policy. Throws when the adapter
 * lacks the capability, when the platform was installed with other options
 * (the adapter's bounds are fixed once installed), or for a retired record.
 * @param {any} platform
 * @param {DeliveryPolicy} policy
 * @returns {{ installedNow: boolean }}
 */
export function ensureDeliveryAuthorization(platform, policy) {
	if (policy.retired) throw new StalePolicyError('[svelte-realtime] realtime({ authorizeDelivery }): this realtime() call was replaced by a newer delivery policy');
	const existing = _installationOf(platform);
	if (existing !== undefined && !_sameOptions(existing.options, policy.options)) {
		throw new Error('[svelte-realtime] realtime({ deliveryAuthorizationOptions }): the installed delivery policy has different options; restart the server to change them');
	}
	let installedNow = false;
	if (existing === undefined) {
		const owner = _owner(platform);
		_installBridge(owner, _activeAuthorize, _ownOptions(policy.options));
		installations.set(owner, { options: _ownOptions(policy.options) });
		installedNow = true;
	}
	if (activePolicy === null) activePolicy = policy;
	else if (activePolicy !== policy && !_samePolicy(activePolicy, policy)) {
		activePolicy.retired = true;
		activePolicy = policy;
		console.warn(formatDiagnostic({
			source: 'svelte-realtime',
			component: 'server.delivery-authorization',
			event: 'delivery-authorization.replaced',
			severity: 'warn',
			message: 'A newer realtime() delivery policy replaced the active one; the replaced one stays retired.',
			attributes: {}
		}));
	}
	return { installedNow };
}

/**
 * Refuse a hook of a retired record: close its connection with 1011 and log
 * the stale diagnostic once per platform.
 * @param {any} ws @param {any} platform
 * @returns {false}
 */
function _refuseStale(ws, platform) {
	const key = platform ? _owner(platform) : reportedStale;
	if (!reportedStale.has(key)) {
		reportedStale.add(key);
		console.error(formatDiagnostic({
			source: 'svelte-realtime',
			component: 'server.delivery-authorization',
			event: 'delivery-authorization.stale',
			severity: 'error',
			message: 'Hooks of a replaced delivery policy ran; their connections are closed.',
			attributes: { closeCode: 1011 }
		}));
	}
	_end(ws);
	return false;
}

/** @param {any} ws */
function _end(ws) {
	try { ws.end(1011, 'Delivery authorization unavailable'); } catch {}
}

/**
 * Connection-level capture point used by every realtime() hook. Activates
 * this call's policy and installs it when init did not. Ends with 1011,
 * before realtime serves it, a connection the policy cannot be installed
 * for, and refuses the hooks of a retired record the same way. When a
 * non-open hook performs the install, the connection was open
 * before any policy existed: it is served, and an `unguarded` diagnostic is
 * logged once per platform.
 * @param {any} ws
 * @param {any} platform
 * @param {DeliveryPolicy} policy
 * @param {boolean} opening whether this is realtime's open hook
 * @returns {boolean} whether the connection may be served
 */
export function guardDeliveryAuthorization(ws, platform, policy, opening) {
	if (activePolicy === policy && platform && _installationOf(platform) !== undefined) return true;
	if (policy.retired) return _refuseStale(ws, platform);
	let installedNow;
	try {
		({ installedNow } = ensureDeliveryAuthorization(platform, policy));
	} catch (error) {
		const key = platform ? _owner(platform) : reportedUnavailable;
		if (!reportedUnavailable.has(key)) {
			reportedUnavailable.add(key);
			console.error(formatDiagnostic({
				source: 'svelte-realtime',
				component: 'server.delivery-authorization',
				event: 'delivery-authorization.unavailable',
				severity: 'error',
				message: 'A delivery policy is configured but could not be installed; connections are closed.',
				attributes: { closeCode: 1011, error: error instanceof Error ? error.message : String(error) }
			}));
		}
		_end(ws);
		return false;
	}
	if (!installedNow || opening) return true;
	const key = _owner(platform);
	if (!reportedUnguarded.has(key)) {
		reportedUnguarded.add(key);
		console.error(formatDiagnostic({
			source: 'svelte-realtime',
			component: 'server.delivery-authorization',
			event: 'delivery-authorization.unguarded',
			severity: 'error',
			message: 'A connection reached realtime before its delivery policy was installed; export init or open from realtime().',
			attributes: {}
		}));
	}
	return true;
}

/** @param {object} ws */
function _admissions(ws) {
	let admissions = subscriptions.get(ws);
	if (!admissions) { admissions = { live: new Map(), retired: new Map(), inflight: new Map() }; subscriptions.set(ws, admissions); }
	return admissions;
}

/**
 * Start a stream admission: attribute the topic before the adapter can
 * deliver on it. Pass the returned token to endDeliveryAdmission.
 * @param {object} ws @param {string} topic @param {string} rpc @param {any[]} args
 * @returns {object | undefined}
 */
export function beginDeliveryAdmission(ws, topic, rpc, args) {
	if (!anyConfigured) return undefined;
	const admissions = _admissions(ws);
	admissions.inflight.set(topic, (admissions.inflight.get(topic) ?? 0) + 1);
	const token = {};
	if (!admissions.live.has(topic)) {
		admissions.retired.delete(topic);
		const { args: owned, copy } = _admit(args);
		admissions.live.set(topic, { rpc, args: owned, copy, confirmed: false, token });
	}
	return token;
}

/**
 * Finish a stream admission. The first admitted stream names the topic,
 * replacing an attribution recorded by an attempt that was not admitted; a
 * refusal drops an unconfirmed attribution once no admission of the topic
 * is in flight.
 * @param {object} ws @param {string} topic @param {string} rpc @param {any[]} args @param {boolean} admitted @param {object | undefined} token
 */
export function endDeliveryAdmission(ws, topic, rpc, args, admitted, token) {
	if (!anyConfigured || token === undefined) return;
	const admissions = _admissions(ws);
	const left = (admissions.inflight.get(topic) ?? 1) - 1;
	if (left > 0) admissions.inflight.set(topic, left);
	else admissions.inflight.delete(topic);
	const admission = admissions.live.get(topic);
	if (admitted) {
		if (admission?.confirmed) return;
		if (admission !== undefined && admission.token === token) { admission.confirmed = true; return; }
		admissions.retired.delete(topic);
		const { args: owned, copy } = _admit(args);
		admissions.live.set(topic, { rpc, args: owned, copy, confirmed: true, token });
	} else if (admission !== undefined && !admission.confirmed && left === 0) {
		admissions.live.delete(topic);
	}
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

/** @param {any} platform */
function _requireCapability(platform) {
	if (typeof platform?.authorizeDelivery !== 'function') {
		throw new Error(
			'[svelte-realtime] realtime({ authorizeDelivery }): the installed svelte-adapter-uws has no platform.authorizeDelivery. ' +
			'Upgrade svelte-adapter-uws to 0.6.0-next.97 or newer, or remove authorizeDelivery.'
		);
	}
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
	_installBridge(platform, () => authorize, options);
}

/**
 * @param {any} platform
 * @param {() => (ctx: any, delivery: any) => unknown} current the policy function, read once per frame so one frame is never decided by two policies
 * @param {any} options
 */
function _installBridge(platform, current, options) {
	_requireCapability(platform);
	const helpers = _getCtxHelpers(platform);
	platform.authorizeDelivery((/** @type {any} */ ws, /** @type {any} */ frame) => {
		const authorize = current();
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
				return authorize(ctx, _descriptor({
					kind: reply.replay === true ? 'replay' : 'snapshot',
					topic: reply.topic, event: null, data: reply.data, binary: false
				}, _admissionOf(ws, reply.topic)));
			}, replies, 0);
		}
		// A request is addressed to one socket and carries no topic.
		const named = typeof topic === 'string' ? topic : null;
		const ctx = _buildCtx(ws.getUserData(), ws, platform, helpers, null);
		return authorize(ctx, _descriptor({
			kind, topic: named, event: frame.event ?? null, data: frame.data, binary: frame.binary === true
		}, named === null ? undefined : _admissionOf(ws, named)));
	}, options);
	anyConfigured = true;
}
