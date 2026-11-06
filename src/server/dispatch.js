// @ts-check
//
// The RPC dispatch nucleus: handleRpc + the guard/execute/respond/migrate chain,
// __directCall, and the message/createMessage hooks. The stateful staying machinery
// (subscription bookkeeping, registry/guard/lazy resolvers, middleware, shared
// validators) lives in server.js and is injected once at init via installDispatch.
import { assert } from '../shared/assert.js';
import { MAX_RPC_BATCH_CALLS } from '../shared/rpc-limits.js';
import { diagnosticErrorMessage, emitOperationalEvent, formatDiagnostic } from '../shared/diagnostic.js';
import { monotonicNow, randomUuid } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _assertRegistrationRevision } from './registration.js';
import { _bindResponseFence, _fenceResponse, _responseFenceFailure } from './response-fence.js';
import { _subscribeTracked } from './membership.js';
import { copyErrorMetadata } from '../shared/error-metadata.js';
import { _IS_DEV } from './env.js';
import { _validPathRe, _DEFAULT_MAX_ENVELOPE_DEPTH, exceedsEnvelopeDepth } from './validate.js';
import { state, registry, guards, cronRegistry, _declaredRedact, _pendingSubscribeHooks, _topicWsCounts } from './state.js';
import { _getBus } from './bus.js';
import { _ensureWrap } from './reactive.js';
import { _getCtxHelpers, _buildCtx, _startCall, _endCall } from './ctx.js';
import { _consumeRateLimitBucket, _resolveRegistryRateLimit, _rateLimitConfig } from './rate-limit.js';
import { _recordRpcMetrics, _recordRpcDelivery, _recordRejectedRpc, _recordRpcOverload, _rpcClosedSockets } from './metrics.js';
import { _shouldShed } from './admission.js';
import { _getIdentityKey, _getAuthenticatedId } from './identity.js';
import { _bindAlarmCtx } from './alarm.js';
import { _registerReplayTopic } from './replay-routing.js';
import { _tenantTopic, _tenantKey, _resolveTenant } from './tenant.js';
import { _derivedScope } from './derived-topic.js';
import { _ownerClaimBegin, _ownerClaimResolve, _presenceClaimBegin, _presenceClaimResolve } from './room-owner.js';
import { _UPLOAD_FRAME_CHUNK, _UPLOAD_FRAME_CONTROL, _handleUploadChunkFrame, _handleUploadControlFrame, _rejectUploadForProtocol, _takeUploadCapAnnouncement } from './upload.js';
import { _isShuttingDown, _enterInFlight, _exitInFlight } from './lifecycle.js';
import { protocolMismatchMessage, protocolMismatchReason } from './protocol-policy.js';
import { beginDeliveryAdmission, endDeliveryAdmission } from './delivery-authorization.js';
import { RPC_ROUTE, rpcTick, _rpcRoute, _admitRpc, _releaseRpc } from './rpc-admission.js';

const textDecoder = new TextDecoder();

// No application value from a failed context is safe to put on the wire or
// in a diagnostic: tenant validation errors can contain the rejected id.
function _contextFailure(path, requestId, err, options) {
	if (options?.onError) {
		try {
			const pending = options.onError(path, err, null);
			if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
		} catch {}
	}
	try {
		emitOperationalEvent({
			source: 'svelte-realtime', component: 'server.rpc',
			event: 'rpc.context.failed', severity: 'error',
			message: 'An RPC context could not be created; the call received an internal error.',
			attributes: { path, requestId, help: 'https://svti.me/tenant' }
		});
	} catch {}
	return { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' };
}

// Synchronous ingress launches async dispatch without awaiting its response.
// Keep the final observer non-throwing, including when delivery or telemetry
// fails after the dispatcher's ordinary request error handling has run.
function _dispatchFailed() {
	try {
		emitOperationalEvent({
			source: 'svelte-realtime', component: 'server.rpc',
			event: 'rpc.dispatch.failed', severity: 'error',
			message: 'An RPC dispatch could not complete.',
			attributes: { help: 'https://svti.me/errors' }
		});
	} catch {}
}

/**
 * Load failures already reported, keyed by path, each holding the error
 * messages seen. A module whose import fails keeps failing on every call, so
 * the diagnostic fires once per distinct failure instead of once per frame. A
 * successful load clears the path, so a later breakage reports again.
 * @type {Map<string, Set<string>>}
 */
const _reportedLoadFailures = new Map();
const _LOAD_FAILURE_REPORT_CAP = 256;

/** Forget reported load failures; a development reload starts the reports over. */
export function _clearLoadFailureReports() {
	_reportedLoadFailures.clear();
}

/**
 * Resolve the live function a call names. A module that fails to load (a
 * syntax error saved in development, a module whose top level throws) answers
 * the call as an internal error instead of rejecting outside the caller's
 * error handling. The entry stays lazy, so a later call loads it again.
 * Callers look a loaded entry up directly and come here only for a lazy or
 * missing one, so a call into a loaded handler allocates nothing extra.
 * @param {string} path
 * @param {string | undefined} requestId
 * @returns {Promise<{ fn: Function | null, failure?: undefined, error?: undefined } | { fn?: undefined, failure: { ok: false, code: string, error: string }, error: unknown }>}
 */
async function _resolveForCall(path, requestId) {
	try {
		const fn = await _resolveRegistryEntry(path);
		if (_reportedLoadFailures.size !== 0) _reportedLoadFailures.delete(path);
		return { fn };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		let seen = _reportedLoadFailures.get(path);
		if (!seen?.has(message)) {
			if (_reportedLoadFailures.size < _LOAD_FAILURE_REPORT_CAP) {
				if (!seen) { seen = new Set(); _reportedLoadFailures.set(path, seen); }
				if (seen.size < _LOAD_FAILURE_REPORT_CAP) seen.add(message);
			}
			emitOperationalEvent({
				source: 'svelte-realtime',
				component: 'server.rpc',
				event: 'rpc.module.load-failed',
				severity: 'error',
				dataClass: 'application',
				message: 'A live module failed to load; the call received an internal error.',
				attributes: { path, requestId, error: diagnosticError(err), help: 'https://svti.me/errors' }
			});
		}
		return { failure: { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' }, error: err };
	}
}

function diagnosticError(error) {
	let name = 'Error';
	let code = null;
	try {
		if (typeof error?.name === 'string') name = error.name;
	} catch {
		// Preserve the response path when application code throws a hostile Proxy.
	}
	try {
		if (error?.code != null) code = diagnosticErrorMessage(error.code);
	} catch {
		// Leave code absent when reading it itself throws.
	}
	return {
		name,
		code,
		message: diagnosticErrorMessage(error)
	};
}

const _MAX_REQUEST_ID_LENGTH = 128;

/**
 * Resolve a client envelope id into the bounded identifier exposed to handler
 * code. Valid printable-ASCII ids are preserved exactly so clients can join
 * logs to their own envelope; malformed ids get a fresh safe server id.
 * @param {unknown} value
 */
function _operationRequestId(value) {
	if (typeof value !== 'string' || value.length < 1 || value.length > _MAX_REQUEST_ID_LENGTH) return randomUuid();
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x21 || code > 0x7e) return randomUuid();
	}
	return value;
}

/** @param {any} result @param {string} requestId */
function _withFailureRequestId(result, requestId) {
	return result && result.ok === false && result.requestId === undefined
		? { ...result, requestId }
		: result;
}

// Seam: stateful staying machinery (subscription bookkeeping, registry/guard/lazy
// resolvers, middleware, shared validators), injected once by server.js at init.
let _isLazyResolved, _trackStreamSub, _rollbackStreamSubscribe, _streamReleaseGeneration, _registerStaleWatch, _registerInvalidationWatch, _resolveRegistryEntry, _resolveGuard, _resolveAllLazy, _runWithMiddleware, _hasMiddleware, _validate, _callTopicFn, _applyInitTransform;
export function installDispatch(seams) {
	_isLazyResolved = seams.isLazyResolved;
	_trackStreamSub = seams.trackStreamSub;
	_rollbackStreamSubscribe = seams.rollbackStreamSubscribe;
	_streamReleaseGeneration = seams.streamReleaseGeneration;
	_registerStaleWatch = seams.registerStaleWatch;
	_registerInvalidationWatch = seams.registerInvalidationWatch;
	_resolveRegistryEntry = seams.resolveRegistryEntry;
	_resolveGuard = seams.resolveGuard;
	_resolveAllLazy = seams.resolveAllLazy;
	_runWithMiddleware = seams.runWithMiddleware;
	_hasMiddleware = seams.hasMiddleware;
	_validate = seams.validate;
	_callTopicFn = seams.callTopicFn;
	_applyInitTransform = seams.applyInitTransform;
}

/**
 * @typedef {object} RpcChainHooks
 * @property {string} [path] - the called path, for diagnostics
 * @property {boolean} [isStream] - the frame is a stream subscribe
 * @property {() => void} [cancel] - the call was refused while its chain still runs
 * @property {() => void} [settled] - that still-running chain has ended
 * @property {{ pending?: Promise<void> }} [track] - receives the promise that settles with that chain
 */

/** Ends a subscribe chain that a middleware answered while it ran. */
const _CALL_ANSWERED = new LiveError('INVALID_REQUEST', 'Call already answered');

/** @param {any} v */
function _isEnvelope(v) {
	return v !== null && typeof v === 'object' && typeof v.ok === 'boolean';
}

/** @param {any} v */
function _isFailureEnvelope(v) {
	return v !== null && typeof v === 'object' && v.ok === false && typeof v.code === 'string';
}

/**
 * Run an RPC's guard/handler chain inside the global middleware and return the
 * answer. Without middleware the chain's own outcome is the answer.
 *
 * With middleware: a returned failure envelope (`{ ok: false, code, error }`)
 * or a thrown error answers at once, so a middleware can time a call out
 * while the handler keeps running; the in-flight count and `hooks.settled`
 * wait for that handler. Any other return waits for the chain, and answers
 * with the middleware's envelope when it returned one, else with the chain's
 * own outcome (a failure the middleware swallowed included). A middleware
 * that returns without calling `next()` and without an envelope fails the
 * call; so does an ok envelope for a stream subscribe, which carries no topic.
 * Once the answer is decided, a late `next()` returns a rejected promise
 * instead of running the rest of the chain.
 *
 * @param {any} ctx
 * @param {() => Promise<any>} runChain
 * @param {RpcChainHooks} [hooks]
 * @returns {Promise<any>}
 */
function _runRpcChain(ctx, runChain, hooks) {
	return _hasMiddleware() ? _runRpcChainThroughMiddleware(ctx, runChain, hooks) : runChain();
}

/**
 * @param {any} ctx
 * @param {() => Promise<any>} runChain
 * @param {RpcChainHooks} [hooks]
 * @returns {Promise<any>}
 */
async function _runRpcChainThroughMiddleware(ctx, runChain, hooks) {
	/** @type {Promise<any> | null} */
	let chainRun = null;
	let chainDone = false;
	let decided = false;
	const path = hooks?.path;
	const detach = () => {
		decided = true;
		const run = chainRun;
		if (!run || chainDone) return;
		hooks?.cancel?.();
		_enterInFlight();
		const settled = run.then(() => {}, (err) => {
			// Nobody receives this failure: the caller already has its answer.
			// A subscribe stopped because of that answer is not a failure.
			if (err === _CALL_ANSWERED) return;
			emitOperationalEvent({
				source: 'svelte-realtime',
				component: 'server.rpc',
				event: 'rpc.execution.failed-after-answer',
				severity: 'warn',
				dataClass: 'application',
				message: 'An RPC handler failed after a middleware had already answered the call.',
				attributes: { path, error: { name: err instanceof Error ? err.name : typeof err, code: err instanceof LiveError ? err.code : null } }
			});
		}).then(() => {
			_exitInFlight();
			hooks?.settled?.();
		});
		if (hooks?.track) hooks.track.pending = settled;
	};
	// Every next() checks this, so after the answer neither an inner
	// middleware nor the handler runs. A rejected promise, not a throw:
	// `setTimeout(next)` must not become an uncaught exception, while an
	// awaiting caller still sees why nothing ran.
	const late = () => {
		if (!decided) return null;
		emitOperationalEvent({
			source: 'svelte-realtime',
			component: 'server.rpc',
			event: 'rpc.middleware.next-after-answer',
			severity: 'warn',
			dataClass: 'application',
			message: 'A middleware called next() after the call was answered; the rest of the chain did not run.',
			attributes: { path }
		});
		const refused = Promise.reject(new Error('middleware called next() after the call was answered'));
		refused.catch(() => {});
		return refused;
	};
	let answer;
	try {
		answer = await _runWithMiddleware(ctx, () => {
			const run = runChain();
			chainRun = run;
			// The middleware may drop the promise; the outcome is read below.
			run.then(() => { chainDone = true; }, () => { chainDone = true; });
			return run;
		}, late);
	} catch (err) {
		detach();
		throw err;
	}
	if (chainRun === null) {
		decided = true;
		if (_isFailureEnvelope(answer)) return answer;
		if (answer && typeof answer === 'object' && answer.ok === true) {
			if (!hooks?.isStream) return answer;
			throw new Error('middleware answered a stream subscribe without calling next(); a subscribe needs next() to run');
		}
		throw new Error('middleware returned without calling next() and without a response envelope; return next() or { ok: false, code, error }');
	}
	if (_isFailureEnvelope(answer) && !chainDone) {
		detach();
		return answer;
	}
	let value;
	try {
		value = await /** @type {Promise<any>} */ (chainRun);
	} catch (err) {
		decided = true;
		if (_isEnvelope(answer)) return answer;
		throw err;
	}
	decided = true;
	if (answer === value) return value;
	if (_isEnvelope(answer)) return answer;
	return value;
}

/**
 * Dev-mode warn dedup for fire-and-forget calls against non-volatile
 * handlers. Bounded so a script-driven barrage doesn't anchor unbounded
 * memory; first 256 distinct paths warn once each, then quiet.
 * @type {Set<string>}
 */
const _volatileWarnSet = new Set();
const _VOLATILE_WARN_CAP = 256;

/**
 * Per-connection record of deprecated paths already signaled, so the wire
 * `deprecation` field is sent at most once per (ws, path) rather than on every
 * call. WeakMap keyed by ws - GC'd with the socket, no explicit cleanup.
 * @type {WeakMap<object, Set<string>>}
 */
const _deprecationInformed = new WeakMap();

/**
 * Per-connection one-shot guard for the protocol-stale notice: a stale client is
 * told once per connection, not on every frame it sends. Keyed by ws, GC'd with
 * the socket.
 * @type {WeakSet<object>}
 */
const _protocolSignaled = new WeakSet();

/**
 * First protocol advertisement received on each connection. A changed second
 * advertisement is invalid: compatibility cannot be renegotiated after calls
 * may already have run.
 * @type {WeakMap<object, { received: true, value: unknown }>}
 */
const _protocolAdvertisement = new WeakMap();

/** @param {object} ws */
function _protocolMismatch(ws) {
	const policy = state.serverProtocolPolicy;
	if (!policy) return null;
	const advertisement = _protocolAdvertisement.get(ws);
	const received = advertisement !== undefined;
	const value = advertisement?.value;
	const reason = protocolMismatchReason(policy, received, value);
	if (!reason) return null;
	return {
		code: 'PROTOCOL_MISMATCH',
		reason,
		server: { current: policy.current, minimum: policy.minimum },
		client: Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? value : null,
		action: policy.onMismatch
	};
}

/**
 * Tell only the affected connection about a range mismatch. This is advisory
 * metadata; `_protocolRejection` owns whether application work is denied.
 * @param {object} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {ReturnType<typeof _protocolMismatch>} mismatch
 */
function _signalProtocolMismatch(ws, platform, mismatch) {
	if (!mismatch || _protocolSignaled.has(ws)) return;
	_protocolSignaled.add(ws);
	try {
		platform.send(ws, '__realtime', 'protocol-mismatch', mismatch);
	} catch { /* a closed socket must never break the message hook */ }
}

/**
 * Return the typed application rejection for a strict incompatible connection,
 * or null when policy is disabled, compatible, or staged as notify-only.
 * @param {object} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 */
function _protocolRejection(ws, platform) {
	const mismatch = _protocolMismatch(ws);
	if (!mismatch) return null;
	_signalProtocolMismatch(ws, platform, mismatch);
	if (state.serverProtocolPolicy?.onMismatch !== 'reject') return null;
	return {
		ok: false,
		code: 'PROTOCOL_MISMATCH',
		error: protocolMismatchMessage(mismatch.reason),
		protocol: mismatch
	};
}

/**
 * Compare a connecting client's advertised protocol version to this server's
 * declared `protocolVersion` (realtime({ protocolVersion })). When the server is
 * NEWER than the client - an older, potentially-incompatible client bundle running
 * against a freshly-deployed server - send that ONE connection a `protocol-stale`
 * notice on the `__realtime` channel so the client can prompt a reload. Unicast via
 * platform.send (NOT publish): staleness is a property of the one connection, never
 * broadcast to every subscriber. Off entirely when the server declared no
 * protocolVersion (one property read). One-shot per connection.
 *
 * The gate is REACTIVE to the client's own advertisement: a client that never sends
 * a proto frame (a bundle predating this feature, or any client that did not set
 * configure({ protocolVersion })) is never signaled. That is by design - the server
 * cannot distinguish a silent old connection from a current one - and it is the one
 * case the signal cannot cover.
 * @param {object} ws
 * @param {{ v?: unknown }} msg - the parsed { type: 'proto', v } frame
 * @param {import('svelte-adapter-uws').Platform} platform
 */
function _protocolGate(ws, msg, platform) {
	const server = state.serverProtocolVersion;
	if (typeof server !== 'number') return; // signal not enabled on this server
	const policy = state.serverProtocolPolicy;
	if (policy) {
		const previous = _protocolAdvertisement.get(ws);
		if (!previous) {
			_protocolAdvertisement.set(ws, { received: true, value: msg?.v });
		} else if (!Object.is(previous.value, msg?.v)) {
			// A connection gets one immutable compatibility identity. Mark a
			// conflicting re-advertisement invalid rather than letting a client
			// switch versions after work may already have executed.
			_protocolAdvertisement.set(ws, { received: true, value: null });
		}
		_signalProtocolMismatch(ws, platform, _protocolMismatch(ws));
		return;
	}
	const client = msg && typeof msg.v === 'number' ? msg.v : 0;
	if (server <= client) return; // client is current (or ahead); nothing actionable
	if (_protocolSignaled.has(ws)) return;
	_protocolSignaled.add(ws);
	try {
		platform.send(ws, '__realtime', 'protocol-stale', { server, client });
	} catch { /* a closed socket must never break the message hook */ }
}

/**
 * Shared proto-frame interception for BOTH message hooks (the default `message` and
 * the `createMessage`-built `customMessage`), so the protocol-compat signal fires on
 * the custom-hook path (clustered / rate-limited deployments) too, and the two hooks
 * cannot drift. Returns true when the frame was the connect-time proto advertisement
 * (the caller should then return without running the RPC / onJsonMessage path).
 * @param {object} ws
 * @param {any} msg - the adapter-forwarded parsed control frame (ctx.msg), or undefined
 * @param {import('svelte-adapter-uws').Platform} platform
 * @returns {boolean}
 */
function _maybeHandleProto(ws, msg, platform) {
	if (msg && msg.type === 'proto') { _protocolGate(ws, msg, platform); return true; }
	return false;
}

/**
 * Return the one-shot `deprecation` signal for a `live.deprecate`-marked handler
 * the first time it responds on a connection (per ws+path), else undefined. Lets
 * the text and binary RPC response paths attach it uniformly with no per-call
 * wire cost on a hot deprecated endpoint. Non-deprecated handlers return
 * undefined immediately (one property read; the common case stays free).
 * @param {object} ws
 * @param {string} path
 * @param {Function} fn
 * @returns {({ path: string } & Record<string, string>) | undefined}
 */
function _deprecationSignal(ws, path, fn) {
	// Walk the __wrappedFn chain (bounded depth 8, like _hasVolatileMarker) so a
	// live.deprecate core wrapped by rateLimit / validated / idempotency / lock /
	// breaker still signals regardless of wrap order. Stream re-wrappers (gate,
	// derived, ...) copy __deprecated forward via _copyStreamMeta, so for those
	// the first iteration finds it directly.
	let info;
	let cur = /** @type {any} */ (fn);
	for (let i = 0; cur && i < 8; i++) {
		if (cur.__deprecated) { info = cur.__deprecated; break; }
		cur = cur.__wrappedFn;
	}
	if (!info) return undefined;
	let informed = _deprecationInformed.get(ws);
	if (!informed) { informed = new Set(); _deprecationInformed.set(ws, informed); }
	if (informed.has(path)) return undefined;
	informed.add(path);
	return { path, ...info };
}

/**
 * Create a per-module guard. Accepts middleware functions (variadic) and/or
 * a single declarative options object as the first argument:
 *
 * - `{ authenticated: true }` - throws UNAUTHENTICATED unless the connection
 *   carries an authenticated identity (`_getAuthenticatedId`: a `ctx.user`
 *   with an `id` / `user_id` / `userId` field). Anonymous adapter-shaped
 *   userData (`{}` / `{ remoteAddress }`) does NOT pass - the adapter always
 *   upgrades with a non-null userData object, so a bare null check would
 *   never fire on a real socket. Cheaper to write than the equivalent
 *   function and harder to forget.
 *
 * Function-style middleware composes: `guard({ authenticated: true }, customCheck)`
 * runs the auth check first, then `customCheck(ctx)`. If any throws, the
 * chain stops. Bare-error throws are auto-classified to LiveError
 * (UNAUTHENTICATED if no authenticated identity, FORBIDDEN otherwise) at the
 * call site.
 *
 * @param {...(Function | { authenticated?: boolean })} parts
 * @returns {Function}
 */
export function guard(...parts) {
	const fns = [];
	for (const part of parts) {
		if (typeof part === 'function') {
			fns.push(part);
			continue;
		}
		if (part && typeof part === 'object') {
			if (part.authenticated === true) {
				fns.push(_guardAuthenticated);
			}
			continue;
		}
		throw new Error('[svelte-realtime] guard() accepts middleware functions or an options object');
	}
	if (fns.length === 0) {
		throw new Error('[svelte-realtime] guard() requires at least one function or option');
	}
	if (fns.length === 1) {
		/** @type {any} */ (fns[0]).__isGuard = true;
		return fns[0];
	}
	const composite = async (ctx) => {
		for (const fn of fns) {
			await fn(ctx);
		}
	};
	/** @type {any} */ (composite).__isGuard = true;
	return composite;
}

async function _guardAuthenticated(ctx) {
	if (!ctx || _getAuthenticatedId(ctx) === null) {
		throw new LiveError('UNAUTHENTICATED', 'Authentication required');
	}
}

/**
 * Run a per-module guard with auto-classification of non-LiveError throws.
 *
 * - LiveError thrown by the guard -> propagated as-is (caller-controlled
 *   code AND message reach the client).
 * - Bare Error / non-Error thrown -> wrapped as
 *   `LiveError(UNAUTHENTICATED, 'Authentication required')` when the
 *   connection has no authenticated identity (`_getAuthenticatedId`),
 *   otherwise `LiveError(FORBIDDEN, 'Access denied')`.
 *   The original error is preserved on `.cause` for server-side logging
 *   but is NOT propagated to the client (avoids accidentally leaking
 *   internal details like a DB error message through a guard).
 *
 * Net: a guard can `throw new Error('whatever')` and the client sees a
 * 4xx-class typed error instead of `INTERNAL_ERROR` (5xx), without any
 * raw error text reaching the wire. To surface a specific reason, throw
 * `new LiveError('FORBIDDEN', 'Account suspended')` directly.
 *
 * @param {Function} guardFn
 * @param {any} ctx
 */
export async function _runGuard(guardFn, ctx) {
	try {
		await guardFn(ctx);
	} catch (err) {
		if (err instanceof LiveError) throw err;
		const code = ctx && _getAuthenticatedId(ctx) !== null ? 'FORBIDDEN' : 'UNAUTHENTICATED';
		const msg = code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied';
		const wrapped = new LiveError(code, msg);
		/** @type {any} */ (wrapped).cause = err;
		throw wrapped;
	}
}

/**
 * The wire reply for an unregistered path. With `realtime({ maskNotFound })`
 * set, answer exactly as `_runGuard` answers a denied caller - same code
 * selection off the same user object, same fixed message - so probing cannot
 * separate "exists but forbidden" from "does not exist". The RPC metric
 * records NOT_FOUND either way; only the wire reply masks.
 *
 * @param {any} ws
 * @param {string} path
 * @returns {{ ok: false, code: string, error: string }}
 */
export function _unknownPathReply(ws, path) {
	if (_IS_DEV) {
		console.warn(formatDiagnostic({
			source: 'svelte-realtime',
			component: 'server.rpc',
			event: 'rpc.path.not-found',
			severity: 'warn',
			message: 'An RPC call did not match a registered live function.',
			attributes: { path, help: 'https://svti.me/rpc' }
		}));
	}
	if (state.maskNotFound) {
		const user = typeof ws?.getUserData === 'function' ? ws.getUserData() : null;
		// Authenticated-identity semantics (not user-non-null): anonymous
		// adapter-shaped userData (`{ remoteAddress }`) must classify as
		// UNAUTHENTICATED, same as the guard paths.
		const code = _getAuthenticatedId({ user }) !== null ? 'FORBIDDEN' : 'UNAUTHENTICATED';
		return { ok: false, code, error: code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied' };
	}
	return { ok: false, code: 'NOT_FOUND', error: 'Not found' };
}

/**
 * Check whether a raw WebSocket message is an RPC request and handle it.
 *
 * @param {any} ws
 * @param {ArrayBuffer} data - Raw message data from the adapter message hook
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void, maxEnvelopeDepth?: number }} [options]
 * @returns {boolean} true if the message was an RPC request
 */
export function handleRpc(ws, data, platform, options) {
	// Auto-capture platform for cron jobs
	if (!state.cronPlatform && cronRegistry.size > 0) state.cronPlatform = platform;

	// Fast path: only process ArrayBuffer
	if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return false;
	const bytes = new Uint8Array(data);

	// Binary RPC: byte[0] = 0x00, byte[1-2] = header length (uint16 BE)
	if (bytes[0] === 0x00 && data.byteLength > 3) {
		const headerLen = (bytes[1] << 8) | bytes[2];
		if (headerLen > 0 && 3 + headerLen <= data.byteLength) {
			try {
				const headerJson = textDecoder.decode(data.slice(3, 3 + headerLen));
				const header = JSON.parse(headerJson);
				// Same post-parse depth cap as the text-RPC path below: the
				// uint16 header budget (~64 KB) still admits ~30000 nesting
				// levels, enough to stack-overflow a host-app recursive walker
				// on the header's args.
				const maxEnvelopeDepth = (options && options.maxEnvelopeDepth) || _DEFAULT_MAX_ENVELOPE_DEPTH;
				if (exceedsEnvelopeDepth(header, maxEnvelopeDepth)) {
					return false;
				}
				if (typeof header.rpc === 'string' && typeof header.id === 'string') {
					const payload = data.slice(3 + headerLen);
					_executeBinaryRpc(ws, header, payload, platform, options).catch(_dispatchFailed);
					return true;
				}
			} catch (err) {
				if (_IS_DEV) {
					console.warn(formatDiagnostic({
						source: 'svelte-realtime',
						component: 'server.rpc',
						event: 'rpc.binary-header.parse-failed',
						severity: 'warn',
						message: 'A binary RPC header could not be parsed.',
						attributes: {
							error: diagnosticError(err),
							help: 'https://svti.me/binary'
						}
					}));
				}
			}
		}
		return false;
	}

	// Upload chunk: byte[0] = 0x01 (live.upload streaming)
	if (bytes[0] === _UPLOAD_FRAME_CHUNK) {
		const rejection = _protocolRejection(ws, platform);
		if (rejection) {
			_rejectUploadForProtocol(ws, data, platform, rejection);
			return true;
		}
		_handleUploadChunkFrame(ws, data, platform, options);
		return true;
	}

	// Upload control: byte[0] = 0x02 (cancel etc)
	if (bytes[0] === _UPLOAD_FRAME_CONTROL) {
		const rejection = _protocolRejection(ws, platform);
		if (rejection) {
			_rejectUploadForProtocol(ws, data, platform, rejection);
			return true;
		}
		_handleUploadControlFrame(ws, data, platform);
		return true;
	}

	// Text RPC: must start with {"r or {"b
	if (data.byteLength < 10) return false;
	// byte[0] = '{' (0x7B), byte[1] = '"' (0x22)
	if (bytes[0] !== 0x7B) return false;
	// byte[2] = 'r' (0x72) for RPC, or 'b' (0x62) for batch
	if (bytes[2] !== 0x72 && bytes[2] !== 0x62) return false;

	/** @type {any} */
	let msg;
	try {
		msg = JSON.parse(textDecoder.decode(data));
	} catch {
		return false;
	}
	// An invalid batch needs no element inspection, including the depth walk.
	// JSON parsing is bounded by the transport's ingress byte limit.
	if (Array.isArray(msg.batch) && msg.batch.length > MAX_RPC_BATCH_CALLS) {
		_executeBatch(ws, msg, platform, options).catch(_dispatchFailed);
		return true;
	}

	// Post-parse depth cap. The adapter's `maxPayloadLength` (default 1 MB)
	// already bounds the bytes JSON.parse ever sees, so this is defense
	// in depth against downstream handlers / instrumentation that recursively
	// walk the parsed object and could stack-overflow on pathological depth.
	// Iterative stack so the check itself never overflows.
	const maxEnvelopeDepth = (options && options.maxEnvelopeDepth) || _DEFAULT_MAX_ENVELOPE_DEPTH;
	if (exceedsEnvelopeDepth(msg, maxEnvelopeDepth)) {
		return false;
	}

	// Batch request: {"batch": [...]}
	if (Array.isArray(msg.batch)) {
		_executeBatch(ws, msg, platform, options).catch(_dispatchFailed);
		return true;
	}

	if (typeof msg.rpc !== 'string') return false;

	// Volatile (fire-and-forget) RPC: frames with no `id` field signal
	// "no reply expected". Server runs the full handler chain but skips
	// the response emit. The wire shape (id absent) is the contract; the
	// matching client surface is `rpc.fireAndForget(...)` plus the
	// `live.volatile()` server-side marker.
	if (msg.id === undefined) {
		if (msg.rpc.length === 0) return false;
		_executeVolatileRpc(ws, msg, platform, options).catch(_dispatchFailed);
		return true;
	}

	if (typeof msg.id !== 'string') return false;

	// envelope.shape invariant: rpc and id must be non-empty for routing
	assert(msg.rpc.length > 0 && msg.id.length > 0, 'realtime/handleRpc.envelope.non-empty', { rpcLen: msg.rpc.length, idLen: msg.id.length });

	// Validated as RPC - handle asynchronously, return true synchronously
	_executeRpc(ws, msg, platform, options).catch(_dispatchFailed);
	return true;
}

/**
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[], stream?: boolean, seq?: number, version?: any }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 */
async function _executeRpc(ws, msg, platform, options) {
	const result = await _executeSingleRpc(ws, msg, platform, options);
	_respond(ws, platform, msg.id, result, undefined, msg.rpc);
}

/**
 * Execute a fire-and-forget RPC. Runs the full handler chain (middleware,
 * guards, rate limits, validation) but does NOT write a response frame.
 * `msg.id` is absent on the wire; an internal correlation id is synthesized
 * so metrics, devtools, and `_executeSingleRpc`'s response shape stay
 * uniform without leaking onto the wire.
 *
 * Dev-mode warns once per non-volatile handler that receives a fire-and-forget
 * call (bounded by `_VOLATILE_WARN_CAP` distinct paths) so accidental
 * `.fireAndForget()` calls against handlers that have a meaningful return
 * value surface in the server log.
 *
 * @param {any} ws
 * @param {{ rpc: string, args?: any[] }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 */
export async function _executeVolatileRpc(ws, msg, platform, options) {
	const path = msg.rpc;
	// A lazy entry is checked after the call has loaded it, so a module that
	// fails to load is imported once per call, not twice.
	const entry = _IS_DEV ? registry.get(path) : null;
	const checkAfter = _IS_DEV && (!entry || !!(/** @type {any} */ (entry).__lazy));
	if (entry && !checkAfter) _warnUnmarkedVolatile(path, entry);
	/** @type {any} */ (msg).id = randomUuid();
	/** @type {any} */ (msg).__volatile = true;
	await _executeSingleRpc(ws, /** @type {any} */ (msg), platform, options);
	// No _respond - fire-and-forget contract.
	if (checkAfter) {
		const fn = registry.get(path);
		if (fn && !/** @type {any} */ (fn).__lazy) _warnUnmarkedVolatile(path, fn);
	}
}

/**
 * Warn once per path when a fire-and-forget call reaches a handler that is not
 * marked `live.volatile()`. Development only.
 * @param {string} path
 * @param {Function} fn
 */
function _warnUnmarkedVolatile(path, fn) {
	if (_hasVolatileMarker(fn) || _volatileWarnSet.has(path)) return;
	if (_volatileWarnSet.size < _VOLATILE_WARN_CAP) _volatileWarnSet.add(path);
	console.warn(formatDiagnostic({
		source: 'svelte-realtime',
		component: 'server.rpc',
		event: 'rpc.volatile.unmarked',
		severity: 'warn',
		message: 'A fire-and-forget call reached a handler that is not marked live.volatile(); errors will be silently dropped.',
		attributes: { path, help: 'https://svti.me/volatile' }
	}));
}

/**
 * Walk the `__wrappedFn` chain produced by `live.rateLimit` / `live.idempotent`
 * / `live.breaker` / `live.validated` / `live.lock` to find an inner
 * `__volatileRpc` marker. Lets users wrap a `live.volatile(handler)` core
 * with any combination of the other markers in any order without tripping
 * the dev-mode "not marked volatile" warning. Bounded walk (depth 8) so a
 * pathological cycle cannot loop forever.
 * @param {any} fn
 */
function _hasVolatileMarker(fn) {
	let cur = fn;
	for (let i = 0; cur && i < 8; i++) {
		if (cur.__volatileRpc) return true;
		cur = cur.__wrappedFn;
	}
	return false;
}

/**
 * Execute a batch of RPC calls. Supports parallel (default) and sequential modes.
 *
 * @param {any} ws
 * @param {{ batch: Array<{ rpc: string, id: string, args?: any[], stream?: boolean }>, sequential?: boolean }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 */
async function _executeBatch(ws, msg, platform, options) {
	const { batch, sequential } = msg;
	const _batchMetricsStart = state.metricsInstruments ? monotonicNow() : 0;

	if (batch.length > MAX_RPC_BATCH_CALLS) {
		return _rejectOversizedBatch(ws, platform, options, _batchMetricsStart);
	}

	if (!_isLazyResolved()) await _resolveAllLazy();
	const registrationRevision = state.registrationRevision;

	/** @type {Array<{ id: string, ok: boolean, data?: any, code?: string, error?: string }>} */
	let results;
	/** @type {Array<{ rollbackStream?: () => void }> | undefined} */
	let streamTracks;

	if (sequential) {
		results = new Array(batch.length);
		for (let i = 0; i < batch.length; i++) {
			const call = batch[i];
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _batchMetricsStart);
				results[i] = { id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id', requestId: _operationRequestId(call?.id) };
				continue;
			}
			// An entry a middleware answered early may still be running; the
			// next entry starts only after it ends.
			/** @type {{ pending?: Promise<void>, rollbackStream?: () => void }} */
			const track = {};
			if (call.stream) (streamTracks ||= [])[i] = track;
			results[i] = await _executeSingleRpc(ws, call, platform, options, track);
			if (track.pending) await track.pending;
		}
	} else {
		results = await Promise.all(batch.map((call, i) => {
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _batchMetricsStart);
				return { id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id', requestId: _operationRequestId(call?.id) };
			}
			const track = call.stream ? {} : undefined;
			if (track) (streamTracks ||= [])[i] = track;
			return _executeSingleRpc(ws, call, platform, options, track);
		}));
	}

	if (state.registrationRevision !== registrationRevision) {
		results = results.map((result, i) => {
			if (result.ok !== true) return result;
			// The client never accepts this stream result. Give up only the
			// ownership this entry admitted; another call can keep the topic.
			streamTracks?.[i]?.rollbackStream?.();
			return { id: result.id, ok: false, code: 'UNAVAILABLE', error: 'Live handlers changed; retry the request', requestId: result.requestId };
		});
	}
	_respond(ws, platform, '__batch', { batch: results }, undefined,
		state.metricsInstruments ? batch.map(call => typeof call?.id === 'string' ? call.rpc : null) : undefined);
}

/** @param {any} ws @param {any} platform @param {any} options @param {number} started */
async function _rejectOversizedBatch(ws, platform, options, started) {
	const path = '__batch__';
	const requestId = randomUuid();
	const close = () => { try { ws.end?.(1008, 'RPC batch limit exceeded'); } catch {} };
	/** @param {any} result */
	const respond = result => {
		// Metrics and delivery observers cannot keep this connection open.
		try { _recordRpcMetrics(path, result.code, started, ws); } catch {}
		try { _respond(ws, platform, '__batch', { ...result, batchRejected: true }, requestId, path); } catch {}
		finally { close(); }
	};
	const protocol = _protocolRejection(ws, platform);
	if (protocol) { respond(protocol); return; }
	if (_isShuttingDown()) {
		respond({ ok: false, code: 'UNAVAILABLE', error: 'Server is shutting down' });
		return;
	}
	_enterInFlight();
	const route = _rpcRoute(path, _rejectOversizedBatch);
	/** @type {import('./rpc-admission.js').RpcConn | null} */
	let conn = null;
	try {
		let permit = /** @type {any} */ (_admitRpc(ws.getUserData(), ws, route, rpcTick));
		if (permit.active === undefined) {
			if (permit.reason === undefined) permit = await permit;
			if (permit.active === undefined) {
				try { _respond(ws, platform, '__batch', { ..._overloaded(path, permit, started, ws), batchRejected: true }, requestId, path); } catch {}
				finally { close(); }
				return;
			}
		}
		conn = permit;
		// One fixed envelope charge; untrusted elements never reach the hook.
		if (options?.beforeExecute) await options.beforeExecute(ws, path, []);
		respond({ ok: false, code: 'INVALID_REQUEST', error: `Batch exceeds maximum of ${MAX_RPC_BATCH_CALLS} calls` });
	} catch (err) {
		if (err instanceof LiveError) {
			respond({ ok: false, code: err.code, error: err.message, ...copyErrorMetadata(err) });
		} else {
			if (options?.onError) { try { options.onError(path, err, null); } catch {} }
			respond({ ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
		}
	} finally {
		if (conn) _releaseRpc(route, conn, null);
		_exitInFlight();
	}
}

// Settle both per-socket claim barriers a stream subscribe opened (the owner
// barrier and the presence self-delivery barrier), keyed by the wire topic.
// Called on EVERY exit of _executeStreamRpc after the barriers are opened - the
// happy path AND every early return (a guard/shed rejection, a subscribe denial
// or throw). Idempotent: a no-op once the paired data-join resolved the real
// owner/roster entry, otherwise a null resolution so the paired :owner/:presence
// loader in this batch reads the shared store instead of awaiting a claim that
// never comes. An unresolved barrier hangs the whole batch (its Promise.all
// never settles) and leaks the in-flight counter, blocking a graceful shutdown.
function _settleClaimBarriers(ws, topic, fn) {
	if (typeof topic !== 'string') return;
	if (/** @type {any} */ (fn).__hasOwner) _ownerClaimResolve(ws, topic, null);
	if (/** @type {any} */ (fn).__hasPresence) _presenceClaimResolve(ws, topic, null);
}

/**
 * The sequence a replay read brings a resuming stream up to, or null when it
 * cannot fill the gap. The entries must run on from the client's cursor with
 * no hole and reach at least the sequence read before them. A buffer trimmed
 * past the cursor returns a later suffix; a buffer that lost its history (a
 * restart, an eviction) returns nothing while its sequence is behind the
 * cursor. Both answer with the loader instead, which replaces the view. Each
 * event of a `set` stream replaces the whole value, so there a hole does not
 * matter: entries after the cursor, in order, whose last one reaches the
 * current sequence carry the value (a `live.flag` buffer keeps one entry).
 * @param {unknown} missed
 * @param {number} clientSeq
 * @param {unknown} currentSeq
 * @param {string | undefined} merge
 * @returns {number | null}
 */
function _replayFilledTo(missed, clientSeq, currentSeq, merge) {
	if (!Array.isArray(missed) || typeof currentSeq !== 'number' || !Number.isSafeInteger(clientSeq) || currentSeq < clientSeq) return null;
	const whole = merge === 'set';
	let last = clientSeq;
	for (const entry of missed) {
		if (entry === null || typeof entry !== 'object' || !Number.isSafeInteger(entry.seq)) return null;
		if (whole ? entry.seq <= last : entry.seq !== last + 1) return null;
		last = entry.seq;
	}
	return last >= currentSeq ? last : null;
}

/**
 * Stream branch of `_executeSingleRpc`: validate args, gate, resolve topic,
 * subscribe, run optional channel/delta/replay/seq-delta short-circuits, run
 * the loader, apply transform/migration, build the response envelope.
 *
 * Mutates `subscribedRef.topic` on successful subscribe so the caller's
 * catch block can roll the subscription back if a later step throws, and
 * `subscribedRef.claimTopic` while a claim barrier is open so the caller's
 * catch can settle it if a throw escapes before the happy-path settle. May
 * itself throw inside `fn(ctx, ...streamArgs)`; that bubbles up to the
 * caller's catch.
 *
 * @param {any} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {Function} fn
 * @param {any} ctx
 * @param {any[]} args
 * @param {{ id: string, seq?: number, schemaVersion?: number, version?: any, attach?: boolean }} msg
 * @param {{ topic: any, claimTopic?: any, cancelled?: boolean, validate?: () => void, isActive?: () => boolean }} subscribedRef
 * @returns {Promise<any>}
 */
async function _executeStreamRpc(ws, platform, fn, ctx, args, msg, subscribedRef, registrationRevision) {
	const result = await _executeStreamRpcInner(ws, platform, fn, ctx, args, msg, subscribedRef, registrationRevision);
	_assertRegistrationRevision(registrationRevision);
	subscribedRef.loaded = result?.ok === true && result.gated !== true;
	return result;
}

async function _executeStreamRpcInner(ws, platform, fn, ctx, args, msg, subscribedRef, registrationRevision) {
	_assertRegistrationRevision(registrationRevision);
	const { id, seq: clientSeq, schemaVersion: clientSchemaVersion } = msg;

	// Validate args BEFORE topic resolution - prevents topic injection
	// via malformed dynamic-topic args (e.g. `audit:${orgId}` with
	// orgId crafted to escape the topic namespace). The validated
	// tuple is bound to a stream-branch-local `let` to keep the
	// outer `args` const for the non-stream path's V8 inline cache.
	let streamArgs = args;
	const argsSchema = /** @type {any} */ (fn).__streamArgs;
	if (argsSchema) {
		const result = _validate(argsSchema, streamArgs);
		if (!result.ok) {
			const err = { id, ok: false, code: 'VALIDATION', error: result.message };
			/** @type {any} */ (err).issues = result.issues;
			return err;
		}
		if (Array.isArray(result.data)) streamArgs = result.data;
	}

	if (/** @type {any} */ (fn).__isGated) {
		const predicate = /** @type {any} */ (fn).__gatePredicate;
		// Await the predicate so an async predicate that returns `false`
		// is denied correctly. A sync predicate is awaited just the same
		// (await unwraps non-Promise values transparently).
		if (!(await predicate(ctx, ...streamArgs))) {
			return { id, ok: true, data: null, gated: true };
		}
	}

	_assertRegistrationRevision(registrationRevision);
	const rawTopic = /** @type {any} */ (fn).__streamTopic;
	let topic = typeof rawTopic === 'function' ? _callTopicFn(rawTopic, ctx, streamArgs) : rawTopic;
	// The reserved-prefix guard runs on the LOGICAL topic (an app cannot subscribe
	// to a `__` system channel) before the tenant prefix is applied.
	if (typeof topic === 'string' && topic.startsWith('__')) {
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'Reserved topic prefix' };
	}
	// Same boundary for the tenant namespace on an UNSCOPED (null-tenant)
	// connection: its namespace is "every topic NOT starting with @t/"
	// (_topicInTenant), but no prefix is applied below for a null tenant, so a
	// client-influenced dynamic topic starting with '@t/' would resolve RAW and
	// land the socket inside another tenant's wire channel. A SCOPED connection
	// is safe - the prefix below wraps the whole logical topic into its own
	// namespace - so only the null tenant is rejected here.
	if (!ctx.tenantId && typeof topic === 'string' && topic.startsWith('@t/')) {
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'Reserved topic prefix' };
	}
	// Tenant prefix once, here, at the boundary: from this point `topic` is the
	// WIRE topic, so subscribe bookkeeping, replay registration, the
	// subscribe/unsubscribe hooks, and the topic-keyed registries
	// (coalesce/transform/volatile/stale/invalidation, all registered below by
	// `topic`) are all keyed by the tenant-scoped string - and a publish, which
	// prefixes the same way, matches. Null tenant -> unchanged (zero cost).
	if (ctx.tenantId && typeof topic === 'string') topic = _tenantTopic(ctx.tenantId, topic);
	if (/** @type {any} */ (fn).__derivedDynamic) {
		const scopeKey = /** @type {any} */ (fn).__derivedScopeKey;
		const admittedScope = _derivedScope(ctx, streamArgs, scopeKey);
		subscribedRef.validate = () => {
			try {
				if (subscribedRef.isActive && !subscribedRef.isActive()) throw new Error('Subscription revoked');
				const user = ws.getUserData();
				const current = _buildCtx(user, ws, platform, _getCtxHelpers(platform), ctx.cursor);
				const scope = _derivedScope(current, streamArgs, scopeKey);
				if (_resolveTenant(user) === ctx.tenantId && scope[0] === admittedScope[0] && scope[1] === admittedScope[1]) return;
			} catch {}
			throw new LiveError('FORBIDDEN', 'Derived scope changed; resubscribe to receive the current view');
		};
	}
	// First-joiner owner delivery: if this is an owner-room DATA stream, open the
	// per-(socket, topic) claim barrier now, before this item awaits anything
	// further. The data-join resolves it with the claimed owner; the paired
	// :owner loader in the same batch awaits it after its own shared-store
	// read, which is what orders the two in practice. A paired loader that
	// runs ahead of this line finds no barrier and serves the store as read
	// (the barrier is soft), so the worst case is a missing self entry, never
	// a hang. Sequencing the value into the subscribe response is what closes
	// the race a timer could not (see room-owner.js).
	if (typeof topic === 'string' && /** @type {any} */ (fn).__hasOwner) _ownerClaimBegin(ws, topic);
	// Same sequencing for a presence room's DATA stream: the paired :presence
	// loader awaits the joiner's own roster entry off the data-join.
	if (typeof topic === 'string' && /** @type {any} */ (fn).__hasPresence) _presenceClaimBegin(ws, topic);
	// Record the topic whose barriers we just opened so the caller's catch settles
	// them if a throw escapes before the happy-path settle below - the room guard
	// (`__streamFilter`) denies by THROWING, not returning false, so a guarded
	// room's data-join throws straight past the early-return settles. The paired
	// sub-stream loaders throw on the same guard before awaiting, so the batch does
	// not hang today, but the open barrier would otherwise outlive the failed join
	// (no subscribe = no unsubscribe drain to clear it) and a LATER lone
	// :presence / :owner subscribe on this socket would await it forever. Cleared
	// at the happy-path settle so a later loader throw never re-settles a consumed
	// barrier. Set only when a barrier actually opened.
	if (typeof topic === 'string' && (/** @type {any} */ (fn).__hasOwner || /** @type {any} */ (fn).__hasPresence)) subscribedRef.claimTopic = topic;
	const streamOpts = /** @type {any} */ (fn).__streamOptions;
	// Per-room alarm (live.alarm): when this stream declares an `alarm` config, bind
	// ctx.setAlarm/getAlarm/deleteAlarm to the resolved WIRE topic so the loader (and
	// any handler running with this ctx) can arm the room's single pending alarm.
	// Keyed by the wire topic so two tenants' same logical room never share an alarm.
	if (streamOpts && streamOpts.alarm && typeof topic === 'string') {
		// Pass the RPC path (`msg.rpc`, the registry key) + tenant as the durable row's
		// resolver metadata so a cross-restart recovery poll can re-find onAlarm via
		// registry.get(path) (the in-memory onAlarm closure is gone after a restart).
		_bindAlarmCtx(ctx, { wireTopic: topic, onAlarm: streamOpts.alarm.onAlarm, alarmId: streamOpts.alarm.id, path: msg.rpc, tenantId: ctx.tenantId, misfireMs: streamOpts.alarm.misfireMs });
	}
	const replayOpts = /** @type {any} */ (fn).__replay;
	// NOTE: replay-topic and dynamic-piiRedact registration for this topic
	// happen AFTER the access filter + subscribe admission below - a denied
	// subscribe must leave no permanent registry entry (and must not make an
	// attacker-chosen topic replay-eligible).

	const streamFilter = /** @type {any} */ (fn).__streamFilter;
	if (streamFilter && !(await streamFilter(ctx, ...streamArgs))) {
		_settleClaimBarriers(ws, topic, fn);
		const code = _getAuthenticatedId(ctx) !== null ? 'FORBIDDEN' : 'UNAUTHENTICATED';
		return { id, ok: false, code, error: code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied' };
	}

	_assertRegistrationRevision(registrationRevision);
	const classOfService = /** @type {any} */ (fn).__classOfService;
	if (classOfService && state.admissionConfig) {
		try {
			if (_shouldShed(platform, classOfService)) {
				_settleClaimBarriers(ws, topic, fn);
				return { id, ok: false, code: 'OVERLOADED', error: `Stream class '${classOfService}' shed under pressure` };
			}
		} catch (err) {
			_settleClaimBarriers(ws, topic, fn);
			return { id, ok: false, code: 'INVALID_REQUEST', error: /** @type {Error} */ (err).message };
		}
	}

	// Wire-level subscribe gate + atomic subscribe. `platform.subscribe`
	// runs the adapter's `subscribe` / `subscribeBatch` hook chain,
	// enforces `MAX_SUBSCRIPTIONS_PER_CONNECTION`, and updates the
	// adapter-side per-connection subscription state (the `subs` Set,
	// `totalSubscriptions` counter, and the close-hook's
	// `ctx.subscriptions` parameter). Without going through this path,
	// the loader would run, deliver initial data, and the room's
	// __onSubscribe would publish a 'join' before the adapter's hook
	// fires (which only fires on the client's follow-on subscribe-batch
	// wire frame, AFTER the stream RPC returns), AND the resulting
	// subscription would be invisible to the adapter's observability
	// surface (close-hook subscriptions set, per-conn cap). The
	// optional-chain on `platform.subscribe` keeps older adapters
	// working: if the method isn't there, we fall back to raw
	// `ws.subscribe` and only the in-realtime gates (`__streamFilter`,
	// `live.room({ guard })`) remain the stream-RPC access checks.
	if (subscribedRef.cancelled) {
		_settleClaimBarriers(ws, topic, fn);
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'Call already answered' };
	}
	// Attribute the topic before the adapter can deliver on it: a frame
	// published as soon as the subscribe takes effect reaches the delivery
	// policy with this stream's rpc and args. A refused admission drops it.
	const _admission = beginDeliveryAdmission(ws, topic, msg.rpc, streamArgs);
	let _subscribeDenial = null;
	try {
		if (typeof platform.subscribe === 'function') {
			// Another stream's failed admission on this socket may release the
			// shared membership after this admission resolved but before this
			// continuation runs. Admit again in that case; the adapter judges a
			// topic it no longer holds through the subscribe hook.
			for (;;) {
				const releases = _streamReleaseGeneration(ws);
				_subscribeDenial = await platform.subscribe(ws, topic);
				if (_subscribeDenial || _streamReleaseGeneration(ws) === releases || state.registrationRevision !== registrationRevision) break;
			}
		} else {
			_subscribeDenial = _subscribeTracked(ws, topic);
		}
	} catch {
		endDeliveryAdmission(ws, topic, msg.rpc, streamArgs, false, _admission);
		_settleClaimBarriers(ws, topic, fn);
		return { id, ok: false, code: 'CONNECTION_CLOSED', error: 'WebSocket closed' };
	}
	endDeliveryAdmission(ws, topic, msg.rpc, streamArgs, !_subscribeDenial, _admission);
	if (state.registrationRevision !== registrationRevision) {
		if (!_subscribeDenial) {
			subscribedRef.isActive = _trackStreamSub(ws, topic, fn, ctx);
			subscribedRef.topic = topic;
		}
		_assertRegistrationRevision(registrationRevision);
	}
	if (_subscribeDenial === 'CONNECTION_CLOSED') {
		_settleClaimBarriers(ws, topic, fn);
		return { id, ok: false, code: 'CONNECTION_CLOSED', error: 'WebSocket closed' };
	}
	if (_subscribeDenial) {
		_settleClaimBarriers(ws, topic, fn);
		return { id, ok: false, code: _subscribeDenial, error: _subscribeDenial === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied' };
	}
	if (subscribedRef.cancelled) {
		// Answered by a middleware while the adapter admitted the subscribe:
		// record it so the chain's end releases it, and run no loader.
		subscribedRef.isActive = _trackStreamSub(ws, topic, fn, ctx);
		subscribedRef.topic = topic;
		throw _CALL_ANSWERED;
	}
	// Name the wire topic to the client once the adapter admitted the
	// subscribe, and before the loader reads its snapshot. The client only
	// learns the topic from the subscribe response, and that response leaves
	// after this item's loader (and, in a batch, after every sibling's). Every
	// frame the subscription delivers in between reaches a socket whose client
	// has no store for the topic yet, and the adapter client drops such frames:
	// a peer's presence join published in that window would be in neither the
	// snapshot nor the live stream. With the attach frame ahead of the loader
	// the client's listener exists for every frame published after the
	// snapshot read can no longer see it, and buffers them until the snapshot
	// lands. A frame published between the adapter's subscribe and this send is
	// dropped by the client, but it was published before the loader runs, so
	// the snapshot carries its state. Sending after admission keeps a caller
	// the adapter's subscribe hook denies from ever learning the resolved
	// (possibly tenant-scoped) topic. Sent only when the request opts in, so an
	// older client never sees a non-ok frame.
	_assertRegistrationRevision(registrationRevision);
	if (msg.attach === true && typeof topic === 'string') {
		_respond(ws, platform, id, { attach: true, topic });
	}
	subscribedRef.isActive = _trackStreamSub(ws, topic, fn, ctx);
	subscribedRef.topic = topic;
	subscribedRef.owner = subscribedRef.isActive.owner;

	// Replay-topic + dynamic-piiRedact registration, performed only now that
	// the subscribe is ADMITTED (access filter passed, platform.subscribe
	// accepted). Running these pre-guard let every denied frame mint a
	// permanent registry entry keyed by an attacker-chosen topic and make that
	// topic replay-eligible. Re-admission of a previously-denied topic is
	// covered naturally: registration runs on every admitted subscribe.
	//
	// Deliberate trade-off, and the opposite of room.js's ordering: registering
	// AFTER `await platform.subscribe` leaves a narrow window where a concurrent
	// publish to a first-subscribed dynamic/tenant topic is not yet
	// replay-eligible and so misses the buffer. room.js registers before its
	// subscribe precisely to close that window, but it is not taking an
	// attacker-chosen topic string. Here the topic is client-influenced, so
	// paying one possibly-unbuffered event on a first subscribe beats handing
	// every denied frame a permanent registry entry. Do not "fix" the ordering
	// without restoring an equivalent bound on denied registrations.
	// Register the replay topic at subscribe for a dynamic (factory) topic so
	// publishers auto-route through replay. A static topic is already registered at
	// declaration with its raw string; under a tenant it must ALSO register the
	// per-tenant WIRE topic here, or the wire-keyed publish would miss the buffer.
	if (replayOpts && typeof topic === 'string' && (typeof rawTopic === 'function' || ctx.tenantId)) {
		// An implicit-replay stream (internal, e.g. the room owner) engages the
		// buffer only when the replay extension is present. Registering it without
		// a platform.replay would burn a permanent registry slot and make
		// _maybeReplayPublish warn about a missing extension the app never opted
		// into; a user-declared replay stream still registers (and warns) as before.
		if (!(/** @type {any} */ (fn).__implicitReplay) || platform.replay) _registerReplayTopic(topic);
	}
	// Dynamic (factory) topic piiRedact: a factory topic has no static
	// `_declaredRedact` entry (that map is keyed by the declaration-time string).
	// After the last subscriber leaves, the refcounted `_topicRedact` entry is
	// evicted - but a replay-eligible topic stays permanently registered, so a
	// later zero-subscriber publish to the resolved wire topic (another RPC, a
	// reactive recompute, top-level publish) would reach the buffer / cluster
	// un-redacted. Register the resolved wire topic's redactor permanently here,
	// mirroring `_registerReplayTopic`'s permanence (bounded by the same per-topic
	// cardinality as the subscriber index). Tenant-scoped STATIC topics are
	// covered instead by the tenant-prefix strip in `_resolveRedactor`.
	const _dynRedactor = /** @type {any} */ (fn).__streamPiiRedact;
	if (_dynRedactor && typeof rawTopic === 'function' && typeof topic === 'string') {
		_declaredRedact.set(topic, { redact: _dynRedactor, onError: /** @type {any} */ (fn).__streamOnError || null });
	}

	_assertRegistrationRevision(registrationRevision);
	if (/** @type {any} */ (fn).__onSubscribe) {
		// `streamArgs` (3rd arg) lets a room enumeration registry capture the
		// room-identifying args of the topic that just gained a subscriber; the
		// presence hook ignores it.
		// Register before invoking user code: even a synchronous hook can close
		// its socket. Drains capture these records before releasing ownership.
		// Most joins finish before a drain. Allocate their completion promise only
		// when a drain actually needs to wait, avoiding an extra hook microtask.
		const joining = /** @type {import('./state.js').PendingSubscribeHook} */ ({ topic, complete: null, promise: null, next: _pendingSubscribeHooks.get(ws) || null });
		_pendingSubscribeHooks.set(ws, joining);
		try { await /** @type {any} */ (fn).__onSubscribe(ctx, topic, streamArgs); } catch {}
		finally {
			joining.complete?.();
			const head = _pendingSubscribeHooks.get(ws);
			if (head === joining) {
				if (joining.next) _pendingSubscribeHooks.set(ws, joining.next);
				else _pendingSubscribeHooks.delete(ws);
			} else {
				for (let previous = head; previous; previous = previous.next) {
					if (previous.next === joining) { previous.next = joining.next; break; }
				}
			}
		}
	}
	_assertRegistrationRevision(registrationRevision);
	// Settle both claim barriers this subscribe opened on the happy path: a no-op
	// when the data-join already resolved with the claimed owner / roster entry,
	// otherwise a null resolution so the paired :owner / :presence loader (a
	// reconnect, an eviction-cap early return, or a hook that threw) reads the
	// shared store instead of waiting on a claim that will never come.
	_settleClaimBarriers(ws, topic, fn);
	// Barrier settled on the happy path: the caller's catch must not re-settle it
	// (a later loader throw would otherwise recreate a slot the paired loader has
	// already consumed).
	subscribedRef.claimTopic = null;
	subscribedRef.validate?.();

	if (/** @type {any} */ (fn).__isDerived && !state.activateDerivedCalled && !state.warnedActivateDerived) {
		if (_IS_DEV) {
			state.warnedActivateDerived = true;
			console.warn('[svelte-realtime] live.derived() subscribed but _activateDerived(platform) was never called. Derived streams will not receive live updates.\n  Call _activateDerived(platform) in your WebSocket open hook.\n  See: https://svti.me/derived');
		}
	}

	// Channel fast-path
	if (/** @type {any} */ (fn).__isChannel) {
		const emptyValue = streamOpts.merge === 'set' ? null : [];
		return { id, ok: true, data: emptyValue, topic, merge: streamOpts.merge, key: streamOpts.key, rowVersion: streamOpts.rowVersion, max: streamOpts.max, channel: true };
	}

	// Record this subscriber for the stream's background reloads (stale
	// watchdog, invalidation watchers) on every path that completes the
	// subscribe, so a reload can run under any current subscriber, including
	// one that resumed from a replay or a delta without running the loader.
	const armReloads = () => {
		_assertRegistrationRevision(registrationRevision);
		// A close, unsubscribe or revoke during a resume await already drained
		// this subscription; binding it now would arm reloads for a dead socket.
		if ((subscribedRef.isActive && !subscribedRef.isActive()) || !_topicWsCounts.get(topic)?.has(ws)) return;
		if (/** @type {any} */ (fn).__streamStaleAfterMs) _registerStaleWatch(topic, fn, ctx, streamArgs, platform);
		if (/** @type {any} */ (fn).__streamInvalidateOn) _registerInvalidationWatch(topic, fn, ctx, streamArgs, platform);
	};

	// Delta sync
	const deltaOpts = /** @type {any} */ (fn).__delta;
	const clientVersion = msg.version;
	if (deltaOpts && clientVersion !== undefined && deltaOpts.version && deltaOpts.diff) {
		try {
			const currentVersion = await deltaOpts.version();
			_assertRegistrationRevision(registrationRevision);
			if (currentVersion === clientVersion) {
				armReloads();
				return { id, ok: true, data: [], topic, merge: streamOpts.merge, key: streamOpts.key, rowVersion: streamOpts.rowVersion, prepend: streamOpts.prepend, max: streamOpts.max, unchanged: true, version: currentVersion };
			}
			let diff = await deltaOpts.diff(clientVersion);
			_assertRegistrationRevision(registrationRevision);
			if (diff !== null && diff !== undefined) {
				// piiRedact on the user-bridged delta egress (this diff is computed
				// fresh by the app, not served from the redacted replay buffer). A
				// redactor throw is caught by the enclosing try and falls through to
				// the loader - fail-closed, never returning raw diff.
				const _redact = /** @type {any} */ (fn).__streamPiiRedact;
				if (_redact) diff = _redact(diff);
				armReloads();
				return { id, ok: true, data: diff, topic, merge: streamOpts.merge, key: streamOpts.key, rowVersion: streamOpts.rowVersion, prepend: streamOpts.prepend, max: streamOpts.max, delta: true, version: currentVersion };
			}
		} catch {}
	}

	// Replay (bounded recent buffer). A stream with a buffer resumes from it
	// or from its loader: a gap the buffer cannot cover goes to the loader,
	// never to `delta.fromSeq`, whose events are numbered by the application.
	const resumesFromBuffer = !!(replayOpts && typeof clientSeq === 'number' && platform.replay);
	if (resumesFromBuffer) {
		try {
			// The current sequence is read first: everything published up to it
			// has to come back from the buffer for the replay to fill the gap.
			const currentSeq = await platform.replay.seq(topic);
			_assertRegistrationRevision(registrationRevision);
			const missed = await platform.replay.since(topic, clientSeq);
			_assertRegistrationRevision(registrationRevision);
			const filledTo = _replayFilledTo(missed, clientSeq, currentSeq, streamOpts.merge);
			if (filledTo !== null) {
				armReloads();
				return { id, ok: true, data: missed, topic, merge: streamOpts.merge, key: streamOpts.key, rowVersion: streamOpts.rowVersion, prepend: streamOpts.prepend, max: streamOpts.max, seq: filledTo, replay: true };
			}
		} catch {}
	}

	// Flag fresh-subscribe seeding (cluster-latest on cold connect). A
	// fresh subscribe omits `seq`, so the seq-gated block above is skipped
	// and the loader would otherwise return this replica's locally-cached
	// value. For a flag backed by shared replay, read the whole buffer
	// (size:1 => one `set` envelope) and serve it through the same
	// `replay: true` array response the seq-gated block uses, so a fresh
	// connect to a replica that never set the flag locally still gets the
	// cluster-latest value. Gated strictly on `__isFlag` so non-flag replay
	// streams (crud/latest, whose loaders intentionally hit the DB on a
	// fresh subscribe) keep loader-only fresh-subscribe behavior. Empty
	// buffer (no `.set()` anywhere yet) falls through to the loader.
	if (replayOpts && platform.replay && typeof clientSeq === 'undefined' && /** @type {any} */ (fn).__isFlag) {
		try {
			const missed = await platform.replay.since(topic, 0);
			_assertRegistrationRevision(registrationRevision);
			if (Array.isArray(missed) && missed.length > 0) {
				const currentSeq = await platform.replay.seq(topic);
			_assertRegistrationRevision(registrationRevision);
				armReloads();
				return { id, ok: true, data: missed, topic, merge: streamOpts.merge, key: streamOpts.key, rowVersion: streamOpts.rowVersion, prepend: streamOpts.prepend, max: streamOpts.max, seq: currentSeq, replay: true };
			}
		} catch {}
	}

	// Seq-delta (user-provided bridge for older-than-buffer reconnects)
	if (!resumesFromBuffer && deltaOpts && typeof deltaOpts.fromSeq === 'function' && typeof clientSeq === 'number') {
		try {
			let events = await deltaOpts.fromSeq(clientSeq);
			_assertRegistrationRevision(registrationRevision);
			if (Array.isArray(events)) {
				// piiRedact on the user-bridged seq-delta egress (these events come
				// from the app's fromSeq bridge, not the redacted replay buffer).
				// Fail-closed via the enclosing try; seq fields are preserved (not
				// matched by the sensitive-key set).
				const _redact = /** @type {any} */ (fn).__streamPiiRedact;
				if (_redact) events = _redact(events);
				// The cursor stays in the application's numbering: an answer without
				// a numbered event carries no seq, so the client keeps its cursor.
				let respSeq;
				if (events.length > 0) {
					const last = events[events.length - 1];
					if (last && typeof last.seq === 'number') respSeq = last.seq;
				}
				const deltaResp = {
					id, ok: true, data: events, topic,
					merge: streamOpts.merge, key: streamOpts.key, rowVersion: streamOpts.rowVersion,
					prepend: streamOpts.prepend, max: streamOpts.max,
					// The application numbers these events, not a replay buffer:
					// the client applies them without checking their continuity.
					replay: true, fromSeq: true
				};
				if (respSeq !== undefined) deltaResp.seq = respSeq;
				armReloads();
				return deltaResp;
			}
		} catch {}
	}

	let result;
	try {
		_assertRegistrationRevision(registrationRevision);
		result = await fn(ctx, ...streamArgs);
	} catch (err) {
		const streamOnError = /** @type {any} */ (fn).__streamOnError;
		if (streamOnError) {
			try { await streamOnError(err, ctx, topic); } catch {}
		}
		throw err;
	}

	// The loader succeeded: arm the watchdog and invalidation watchers (one
	// per topic, or per (pattern, topic)) and record this subscriber.
	armReloads();

	const isPaginated = result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result;
	let resultData = isPaginated ? result.data : result;

	// Apply transform to initial data: per-item for arrays
	// (crud/latest/presence/cursor merge), whole-value for non-arrays
	// (set merge). Live-event transforms run separately at publish time.
	const initTransform = /** @type {any} */ (fn).__streamTransform;
	if (initTransform && resultData != null) {
		resultData = _applyInitTransform(initTransform, resultData);
	}

	// PII redaction on the initial-load egress, after transform. The redactor
	// is non-mutating and handles arrays itself, so it applies to the whole
	// result. Fail-closed: a throwing redactor must never return un-redacted
	// initial data, so drop to null and surface to the stream's onError.
	const initRedact = /** @type {any} */ (fn).__streamPiiRedact;
	if (initRedact && resultData != null) {
		try {
			resultData = initRedact(resultData);
		} catch (err) {
			const onErr = /** @type {any} */ (fn).__streamOnError;
			if (onErr) { try { onErr(err, ctx, topic); } catch {} }
			resultData = null;
		}
	}

	// Schema migration. `schemaVersion` arrives on the client frame, so
	// re-validate the client's own contract (subscribeAt: "must be a
	// non-negative integer") at the trust boundary: anything else - negative,
	// fractional, NaN, or -Infinity (JSON -1e999) - means NO migration. A
	// negative value would otherwise send `_migrateItem`'s `from < to` loop
	// into an unbounded spin (-Infinity: a permanent one), wedging the
	// event loop on a single frame.
	const serverVersion = /** @type {any} */ (fn).__streamVersion;
	const migrateFns = /** @type {any} */ (fn).__streamMigrate;
	if (serverVersion !== undefined && migrateFns && Number.isInteger(clientSchemaVersion) && clientSchemaVersion >= 0 && clientSchemaVersion < serverVersion) {
		resultData = _migrateData(resultData, clientSchemaVersion, serverVersion, migrateFns);
	}

	const response = {
		id, ok: true, data: resultData, topic, merge: streamOpts.merge,
		key: streamOpts.key, rowVersion: streamOpts.rowVersion, prepend: streamOpts.prepend, max: streamOpts.max,
		hasMore: undefined, cursor: undefined, seq: undefined,
		version: undefined, schemaVersion: undefined, replay: undefined
	};

	if (isPaginated) {
		response.hasMore = result.hasMore;
		if (result.cursor !== undefined) response.cursor = result.cursor;
	}
	if (replayOpts && platform.replay) {
		try { response.seq = await platform.replay.seq(topic); } catch {}
	}
	if (typeof clientSeq === 'number') response.replay = false;
	if (deltaOpts && deltaOpts.version) {
		try { response.version = await deltaOpts.version(); } catch {}
	}
	if (serverVersion !== undefined) response.schemaVersion = serverVersion;

	return response;
}

/**
 * Execute a single RPC call and return the result (used by batch and single execution).
 *
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[], stream?: boolean }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 * @returns {Promise<{ id: string, ok: boolean, data?: any, code?: string, error?: string, requestId?: string }>}
 */
/**
 * Graceful-shutdown wrapper around the RPC funnel (text + volatile + batch +
 * the stream-subscribe branch all flow through here). Once a drain has begun,
 * new calls are rejected with `UNAVAILABLE` and are NOT counted in-flight (they
 * return immediately); every accepted call is counted so `onShutdown`'s drain
 * waits for it to settle. Counting happens before the first `await` so there is
 * no gap between the gate check and the in-flight increment.
 */
async function _executeSingleRpc(ws, msg, platform, options, track) {
	const requestId = _operationRequestId(msg.id);
	const protocolRejection = _protocolRejection(ws, platform);
	if (protocolRejection) {
		_recordRejectedRpc(msg.rpc, protocolRejection.code, ws);
		return { id: msg.id, ...protocolRejection, requestId };
	}
	if (_isShuttingDown()) {
		_recordRejectedRpc(msg.rpc, 'UNAVAILABLE', ws);
		return { id: msg.id, ok: false, code: 'UNAVAILABLE', error: 'Server is shutting down', requestId };
	}
	_enterInFlight();
	try {
		const trace = platform?.trace;
		const result = trace?.enabled
			? await trace.run('realtime.rpc', {
				kind: 'server',
				parent: platform.traceContext,
				attributes: { 'rpc.system': 'svelte-realtime' }
			}, () => _executeSingleRpcInner(ws, msg, platform, options, requestId, track))
			: await _executeSingleRpcInner(ws, msg, platform, options, requestId, track);
		return _withFailureRequestId(result, requestId);
	} finally {
		_exitInFlight();
	}
}

async function _executeSingleRpcInner(ws, msg, platform, options, requestId, track) {
	const { rpc: path, id, args: rawArgs, stream: isStream, cursor: clientCursor } = msg;
	const _metricsStart = state.metricsInstruments ? monotonicNow() : 0;

	if (!_validPathRe.test(path)) {
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'Invalid path' };
	}

	if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
		// Pre-registry (path not yet resolved), so it may be unregistered and
		// client-controlled: fold to a bounded label rather than record the raw path.
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' };
	}

	if (!_isLazyResolved()) await _resolveAllLazy();
	const registrationRevision = state.registrationRevision;

	const args = rawArgs || [];
	let fn = registry.get(path);
	if (fn === undefined || /** @type {any} */ (fn).__lazy) {
		const resolved = await _resolveForCall(path, requestId);
		if (resolved.failure) {
			if (options?.onError) {
				try { options.onError(path, resolved.error, _buildCtx(ws.getUserData(), ws, platform, _getCtxHelpers(platform), clientCursor !== undefined ? clientCursor : null, msg.idempotencyKey, requestId)); } catch {}
			}
			_recordRpcMetrics(path, 'INTERNAL_ERROR', _metricsStart);
			return { id, ...resolved.failure };
		}
		fn = resolved.fn;
	}
	if (!fn) {
		// Fold the unregistered (client-controlled) path to a bounded label - an
		// unauthenticated caller must not be able to allocate a metric series per
		// distinct unknown path. See metrics.js for the length backstop.
		_recordRpcMetrics('__unknown__', 'NOT_FOUND', _metricsStart);
		return { id, ..._unknownPathReply(ws, path) };
	}

	// Occupancy admission: a call that cannot start waits in the bounded queue
	// or is refused at once, and a refused call runs nothing.
	const user = ws.getUserData();
	const route = /** @type {any} */ (fn)[RPC_ROUTE] || _rpcRoute(path, fn);
	const arrived = rpcTick;
	let permit = _admitRpc(user, ws, route, arrived);
	if (/** @type {any} */ (permit).active === undefined) {
		if (/** @type {any} */ (permit).reason === undefined) permit = await permit;
		if (/** @type {any} */ (permit).active === undefined) {
			return { id, ..._overloaded(path, /** @type {any} */ (permit), _metricsStart, ws) };
		}
	}
	const conn = /** @type {import('./rpc-admission.js').RpcConn} */ (permit);
	// A middleware that answers early leaves the handler running; its permit
	// then goes back when that handler settles.
	let detached = false;

	let ctx;
	try {
		ctx = _buildCtx(user, ws, platform, _getCtxHelpers(platform), clientCursor !== undefined ? clientCursor : null, msg.idempotencyKey, requestId);
	} catch (err) {
		_releaseRpc(route, conn, null);
		_recordRpcMetrics(path, 'INTERNAL_ERROR', _metricsStart, ws);
		return { id, ..._contextFailure(path, requestId, err, options) };
	}
	_startCall(ctx, conn, route.ticks === 0 ? -1 : arrived + route.ticks);
	/** @type {{ topic: any, claimTopic: any, cancelled?: boolean, validate?: () => void, isActive?: () => boolean }} */
	const _subscribedRef = { topic: null, claimTopic: null };
	// Only a middleware can answer while the chain still runs; the chain's
	// subscribe bookkeeping is then released when it ends, not here.
	const _hooks = _hasMiddleware() ? {
		path,
		track,
		isStream: !!isStream,
		cancel() { _subscribedRef.cancelled = true; detached = true; },
		settled() {
			if (_subscribedRef.topic) _rollbackStreamSubscribe(ws, _subscribedRef.topic, fn, ctx, _subscribedRef.isActive);
			if (_subscribedRef.claimTopic) _settleClaimBarriers(ws, _subscribedRef.claimTopic, fn);
			_releaseRpc(route, conn, _endCall(ctx));
		}
	} : undefined;

	try {
		let _result = await _runRpcChain(ctx, async () => {
		const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
		const guardFn = await _resolveGuard(modulePath);
		if (guardFn) await _runGuard(guardFn, ctx);

		// A stream entry is its loader: calling it as a plain RPC would skip
		// the subscribe-side access/filter, args schema and gate, and return
		// the snapshot. Only a subscribe frame reaches a stream. Checked after
		// the guard so the endpoint kind stays private until access is granted.
		const isStreamEntry = /** @type {any} */ (fn).__isStream;
		if (isStreamEntry && !isStream) {
			throw new LiveError('INVALID_REQUEST', 'Streams must be subscribed, not called');
		}

		if (options?.beforeExecute) {
			await options.beforeExecute(ws, path, args);
		}

		if (isStreamEntry) {
			return await _executeStreamRpc(ws, platform, fn, ctx, args, msg, _subscribedRef, registrationRevision);
		} else {
			// Registry-level rate limit. Per-handler `live.rateLimit(...)`
			// wraps fn directly and runs its own check inside the wrapper, so
			// we skip the registry check when __isRateLimited is set --
			// "explicit per-handler wins over central config".
			if (_rateLimitConfig && !(/** @type {any} */ (fn).__isRateLimited)) {
				const rule = _resolveRegistryRateLimit(path);
				if (rule) {
					const userKey = _getIdentityKey(ctx);
					// Tenant-scope the registry-level bucket too (null tenant -> unchanged).
					const r = _consumeRateLimitBucket(_tenantKey(ctx.tenantId, path + '\0' + userKey), rule.points, rule.window);
					if (!r.ok) {
						/** @type {any} */
						const out = { id, ok: false, code: 'RATE_LIMITED', error: 'Too many requests' };
						out.retryAfter = r.retryAfter;
						return out;
					}
				}
			}
			_assertRegistrationRevision(registrationRevision);
			const result = await fn(ctx, ...args);
			return { id, ok: true, data: result };
		}
		}, _hooks); // end middleware chain
		_assertRegistrationRevision(registrationRevision);
		// A middleware's own envelope answers for this call id.
		if (_result.id !== id) _result = { ..._result, id };
		if (_subscribedRef.topic && !_subscribedRef.cancelled) {
			if (_result.ok === false) {
				// A middleware refused a subscribe the chain completed.
				_rollbackStreamSubscribe(ws, _subscribedRef.topic, fn, ctx, _subscribedRef.isActive);
				if (_subscribedRef.claimTopic) _settleClaimBarriers(ws, _subscribedRef.claimTopic, fn);
			} else {
				_subscribedRef.validate?.();
			}
		}
		if (/** @type {any} */ (fn).__isStream && _result.ok === true && _subscribedRef.loaded && _subscribedRef.owner &&
			_subscribedRef.isActive() && (/** @type {any} */ (fn).__onSubscribeSuccess || /** @type {any} */ (fn).__onUnsubscribePublic)) {
			_subscribedRef.owner.publicAttached = (_subscribedRef.owner.publicAttached || 0) + 1;
			const joining = { topic: _subscribedRef.topic, complete: null, promise: null, next: _pendingSubscribeHooks.get(ws) || null };
			_pendingSubscribeHooks.set(ws, joining);
			try { await /** @type {any} */ (fn).__onSubscribeSuccess?.(ctx, _subscribedRef.topic ?? _result.topic); } catch {}
			finally {
				joining.complete?.();
				const head = _pendingSubscribeHooks.get(ws);
				if (head === joining) {
					if (joining.next) _pendingSubscribeHooks.set(ws, joining.next);
					else _pendingSubscribeHooks.delete(ws);
				} else {
					for (let previous = head; previous; previous = previous.next) {
						if (previous.next === joining) { previous.next = joining.next; break; }
					}
				}
			}
		}
		_assertRegistrationRevision(registrationRevision);
		// Deprecation signal (live.deprecate): one-shot per (ws, path), attached to
		// the first ok response so the client warns once. Covers text/batch/
		// stream-subscribe (all flow through here); binary RPC attaches its own.
		// Skip fire-and-forget calls: no response is sent, so consuming the
		// one-shot would silently swallow it and starve a later real call.
		if (_result && _result.ok !== false && !msg.__volatile) {
			const dep = _deprecationSignal(ws, path, fn);
			if (dep) /** @type {any} */ (_result).deprecation = dep;
		}
		_recordRpcMetrics(path, (_result && _result.ok === false) ? (_result.code || 'UNKNOWN') : '', _metricsStart, ws);
		_assertRegistrationRevision(registrationRevision);
		if (!msg.__volatile) _bindResponseFence(ctx, _result, requestId);
		// A stream can finish before its batch siblings. Keep its cleanup
		// until the batch decides whether this successful result may be sent.
		if (track && _result.ok === true && _subscribedRef.topic && !_subscribedRef.cancelled) {
			track.rollbackStream = () => {
				track.rollbackStream = undefined;
				_rollbackStreamSubscribe(ws, _subscribedRef.topic, fn, ctx, _subscribedRef.isActive);
				if (_subscribedRef.claimTopic) _settleClaimBarriers(ws, _subscribedRef.claimTopic, fn);
			};
		}
		return _result;
	} catch (err) {
		// After an early middleware answer, the still-running chain releases its
		// own subscribe when it ends.
		if (!_subscribedRef.cancelled) {
			if (_subscribedRef.topic) _rollbackStreamSubscribe(ws, _subscribedRef.topic, fn, ctx, _subscribedRef.isActive);
			// A throw that escaped after the claim barriers opened but before the
			// happy-path settle (the guard `__streamFilter` throws, an internal
			// bookkeeping failure) would leave a paired :owner/:presence loader in this
			// batch - and any later lone sub-stream subscribe on this socket - awaiting
			// a claim that never resolves. Settle to null here (cleared on the happy
			// path, so this only fires on that pre-settle throw window).
			if (_subscribedRef.claimTopic) _settleClaimBarriers(ws, _subscribedRef.claimTopic, fn);
		}
		_recordRpcMetrics(path, err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart, ws);
		if (err instanceof LiveError) {
			/** @type {any} */
			const result = { id, ok: false, code: err.code, error: err.message };
			if ('params' in err || 'details' in err || 'retryAfter' in err) Object.assign(result, copyErrorMetadata(err));
			if (/** @type {any} */ (err).issues) result.issues = /** @type {any} */ (err).issues;
			return result;
		}
		if (options?.onError) {
			try { options.onError(path, err, ctx); } catch {}
		}
		emitOperationalEvent({
				source: 'svelte-realtime',
				component: 'server.rpc',
				event: 'rpc.execution.non-live-error',
				severity: 'warn',
				dataClass: 'application',
				message: 'An RPC handler threw a non-LiveError; raw errors are hidden from clients.',
				attributes: {
					path,
					requestId,
					error: diagnosticError(err),
					help: 'https://svti.me/errors'
				}
			});
		return { id, ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' };
	} finally {
		if (!detached) _releaseRpc(route, conn, _endCall(ctx));
	}
}

/**
 * Count a call admission refused and build its failure envelope. A call
 * whose connection closed while it waited ends without an admission label;
 * nobody receives its reply.
 * @param {string} path
 * @param {import('./rpc-admission.js').RpcRejection} rejection
 * @param {number} metricsStart
 * @param {any} ws
 */
function _overloaded(path, rejection, metricsStart, ws) {
	if (rejection.closed) {
		_recordRpcMetrics(path, 'CONNECTION_CLOSED', metricsStart, ws);
		return { ok: false, code: 'CONNECTION_CLOSED', error: 'The connection closed' };
	}
	const { reason, scope } = rejection;
	_recordRpcMetrics(path, 'OVERLOADED', metricsStart, ws);
	_recordRpcOverload(path, reason, scope);
	if (rejection.expired) return { ok: false, code: 'OVERLOADED', error: 'The call waited past its deadline', reason, scope };
	if (reason === 'queue_full') return { ok: false, code: 'OVERLOADED', error: 'The call queue is full', reason, scope };
	return { ok: false, code: 'OVERLOADED', error: 'Too many concurrent calls', reason, scope };
}

/**
 * Execute a binary RPC call.
 *
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[] }} header
 * @param {ArrayBuffer} payload - Raw binary data
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: Function, onError?: Function }} [options]
 */
async function _executeBinaryRpc(ws, header, payload, platform, options) {
	const requestId = _operationRequestId(header.id);
	const protocolRejection = _protocolRejection(ws, platform);
	if (protocolRejection) {
		_recordRejectedRpc(header.rpc, protocolRejection.code, ws);
		_respond(ws, platform, header.id, protocolRejection, requestId, header.rpc);
		return;
	}
	if (_isShuttingDown()) {
		_recordRejectedRpc(header.rpc, 'UNAVAILABLE', ws);
		_respond(ws, platform, header.id, { ok: false, code: 'UNAVAILABLE', error: 'Server is shutting down' }, requestId, header.rpc);
		return;
	}
	_enterInFlight();
	try {
		await _executeBinaryRpcInner(ws, header, payload, platform, options, requestId);
	} finally {
		_exitInFlight();
	}
}

async function _executeBinaryRpcInner(ws, header, payload, platform, options, requestId) {
	const { rpc: path, id, args: extraArgs } = header;
	const _metricsStart = state.metricsInstruments ? monotonicNow() : 0;

	if (!_validPathRe.test(path)) {
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'Invalid path' }, requestId, path);
		return;
	}

	if (extraArgs !== undefined && !Array.isArray(extraArgs)) {
		// Pre-registry (path not yet resolved), so it may be unregistered and
		// client-controlled: fold to a bounded label rather than record the raw path.
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' }, requestId, path);
		return;
	}

	if (!_isLazyResolved()) await _resolveAllLazy();
	const registrationRevision = state.registrationRevision;
	let fn = registry.get(path);
	if (fn === undefined || /** @type {any} */ (fn).__lazy) {
		const resolved = await _resolveForCall(path, requestId);
		if (resolved.failure) {
			if (options?.onError) {
				try { options.onError(path, resolved.error, _buildCtx(ws.getUserData(), ws, platform, _getCtxHelpers(platform), null, null, requestId)); } catch {}
			}
			_recordRpcMetrics(path, 'INTERNAL_ERROR', _metricsStart);
			_respond(ws, platform, id, resolved.failure, requestId, path);
			return;
		}
		fn = resolved.fn;
	}
	if (!fn) {
		// Fold the unregistered (client-controlled) path to a bounded label - an
		// unauthenticated caller must not be able to allocate a metric series per
		// distinct unknown path. See metrics.js for the length backstop.
		_recordRpcMetrics('__unknown__', 'NOT_FOUND', _metricsStart);
		_respond(ws, platform, id, _unknownPathReply(ws, path), requestId, path);
		return;
	}

	const user = ws.getUserData();
	const route = /** @type {any} */ (fn)[RPC_ROUTE] || _rpcRoute(path, fn);
	const arrived = rpcTick;
	let permit = _admitRpc(user, ws, route, arrived);
	if (/** @type {any} */ (permit).active === undefined) {
		if (/** @type {any} */ (permit).reason === undefined) permit = await permit;
		if (/** @type {any} */ (permit).active === undefined) {
			_respond(ws, platform, id, _overloaded(path, /** @type {any} */ (permit), _metricsStart, ws), requestId, path);
			return;
		}
	}
	const conn = /** @type {import('./rpc-admission.js').RpcConn} */ (permit);
	let detached = false;

	let ctx;
	try {
		ctx = _buildCtx(user, ws, platform, _getCtxHelpers(platform), null, null, requestId);
	} catch (err) {
		_releaseRpc(route, conn, null);
		_recordRpcMetrics(path, 'INTERNAL_ERROR', _metricsStart, ws);
		_respond(ws, platform, id, _contextFailure(path, requestId, err, options), requestId, path);
		return;
	}
	_startCall(ctx, conn, route.ticks === 0 ? -1 : arrived + route.ticks);

	try {
		let answer = await _runRpcChain(ctx, async () => {
			const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
			const guardFn = await _resolveGuard(modulePath);
			if (guardFn) await _runGuard(guardFn, ctx);

			// Endpoint type and limits are private until the guard permits access.
			if (!/** @type {any} */ (fn).__isBinary) throw new LiveError('INVALID_REQUEST', 'Not a binary endpoint');
			const maxBinarySize = /** @type {any} */ (fn).__maxBinarySize || 10485760;
			if (payload.byteLength > maxBinarySize) throw new LiveError('PAYLOAD_TOO_LARGE', 'Binary payload exceeds size limit');

			if (options?.beforeExecute) {
				await options.beforeExecute(ws, path, [payload, ...(extraArgs || [])]);
			}

			_assertRegistrationRevision(registrationRevision);
			const result = await fn(ctx, payload, ...(extraArgs || []));
			return { ok: true, data: result };
		}, _hasMiddleware() ? { path, cancel() { detached = true; }, settled() { _releaseRpc(route, conn, _endCall(ctx)); } } : undefined);
		_assertRegistrationRevision(registrationRevision);
		// Consumed only by an answer that succeeds, so a middleware refusal
		// leaves the one-shot deprecation signal for a later call.
		if (answer.ok !== false) {
			const _dep = _deprecationSignal(ws, path, fn);
			if (_dep) answer = { ...answer, deprecation: _dep };
		}
		_bindResponseFence(ctx, answer, requestId);
		_respond(ws, platform, id, answer, requestId, path);
		_recordRpcMetrics(path, answer.ok === false ? (answer.code || 'UNKNOWN') : '', _metricsStart, ws);
	} catch (err) {
		_recordRpcMetrics(path, err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart, ws);
		if (err instanceof LiveError) {
			const result = { ok: false, code: err.code, error: err.message };
			if ('params' in err || 'details' in err || 'retryAfter' in err) Object.assign(result, copyErrorMetadata(err));
			_respond(ws, platform, id, result, requestId, path);
		} else {
			if (options?.onError) {
				try { options.onError(path, err, ctx); } catch {}
			}
			emitOperationalEvent({
					source: 'svelte-realtime',
					component: 'server.rpc',
					event: 'rpc.binary.execution-failed',
					severity: 'error',
					dataClass: 'application',
					message: 'A binary RPC handler failed.',
					attributes: {
						path,
						requestId,
						error: diagnosticError(err),
						help: 'https://svti.me/binary'
					}
				});
			_respond(ws, platform, id, { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' }, requestId, path);
		}
	} finally {
		if (!detached) _releaseRpc(route, conn, _endCall(ctx));
	}
}

/**
 * Send an RPC response to a single client.
 * @param {any} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {string} correlationId
 * @param {Record<string, any>} payload
 */
/**
 * Apply schema migration functions to data.
 * Chains migrations from clientVersion to serverVersion.
 * @param {any} data
 * @param {number} fromVersion
 * @param {number} toVersion
 * @param {Record<number, (item: any) => any>} migrateFns
 * @returns {any}
 */
function _migrateData(data, fromVersion, toVersion, migrateFns) {
	if (Array.isArray(data)) {
		return data.map(item => _migrateItem(item, fromVersion, toVersion, migrateFns));
	}
	return _migrateItem(data, fromVersion, toVersion, migrateFns);
}

/**
 * Apply chained migrations to a single item.
 * @param {any} item
 * @param {number} fromVersion
 * @param {number} toVersion
 * @param {Record<number, (item: any) => any>} migrateFns
 * @returns {any}
 */
function _migrateItem(item, fromVersion, toVersion, migrateFns) {
	let result = item;
	for (let v = fromVersion; v < toVersion; v++) {
		const fn = migrateFns[v];
		if (fn) {
			result = fn(result);
		} else if (_IS_DEV) {
			console.warn(formatDiagnostic({
				source: 'svelte-realtime',
				component: 'server.rpc',
				event: 'rpc.schema.migration-missing',
				severity: 'warn',
				message: 'An RPC schema migration function is missing.',
				attributes: { fromVersion: v, toVersion: v + 1, help: 'https://svti.me/schema' }
			}));
		}
	}
	return result;
}

function _respond(ws, platform, correlationId, payload, requestId, paths) {
	const source = payload;
	payload = requestId ? _withFailureRequestId(payload, requestId) : payload;
	// The first response on a connection carries the upload frame cap, so a
	// client that called anything before uploading sizes chunk 0 from it.
	if (state.uploadEndpoints) {
		const cap = _takeUploadCapAnnouncement(ws, platform);
		if (cap > 0) payload = { ...payload, __cap: cap };
	}
	if (_IS_DEV) {
		// Estimate size without double-serialization.
		const data = payload.data;
		if ((Array.isArray(data) && data.length > 5000) || (typeof data === 'string' && data.length > 800_000)) {
			console.warn(formatDiagnostic({
				source: 'svelte-realtime',
				component: 'server.rpc',
				event: 'rpc.response.large',
				severity: 'warn',
				message: 'An RPC response may exceed maxPayloadLength.',
				attributes: {
					correlationId,
					length: data.length,
					help: 'https://svti.me/adapter-config'
				}
			}));
		}
	}
	const trackDelivery = state.metricsInstruments !== null && paths !== undefined;
	const closedBefore = trackDelivery ? platform.closedWsAborts : undefined;
	/** @type {'delivered' | 'backpressure' | 'closed' | 'exception'} */
	let outcome = 'exception';
	try {
		payload = _fenceResponse(source, payload, requestId ?? correlationId);
		const result = platform.send(ws, '__rpc', correlationId, payload);
		if (trackDelivery) {
			// Native sends return 1 on success, 0 for buffered backpressure,
			// and 2 when dropped. The adapter counts closed-socket aborts.
			outcome = _rpcClosedSockets.has(ws) || platform.closedWsAborts > closedBefore ? 'closed'
				: result === 0 || result === 2 ? 'backpressure' : 'delivered';
		}
		if (result === 0 && _IS_DEV) {
			console.warn(formatDiagnostic({
				source: 'svelte-realtime',
				component: 'server.rpc',
				event: 'rpc.response.undelivered',
				severity: 'warn',
				message: 'An RPC response was not delivered.',
				attributes: { correlationId, reason: 'backpressure-or-closed' }
			}));
		}
	} catch (err) {
		if (trackDelivery && _rpcClosedSockets.has(ws)) outcome = 'closed';
		// uWS throws when accessing a closed WebSocket - expected during mid-RPC disconnect.
		if (_IS_DEV) {
			console.warn(formatDiagnostic({
				source: 'svelte-realtime',
				component: 'server.rpc',
				event: 'rpc.response.undelivered',
				severity: 'warn',
				message: 'An RPC response was not delivered.',
				attributes: {
					correlationId,
					reason: 'send-threw',
					error: diagnosticError(err)
				}
			}));
		}
	} finally {
		if (trackDelivery) {
			if (Array.isArray(paths)) {
				for (const path of paths) _recordRpcDelivery(path, outcome);
			} else _recordRpcDelivery(paths, outcome);
		}
	}
}

/**
 * Execute a live function directly (in-process), without WebSocket.
 * Used by SSR load functions to call live functions server-side.
 *
 * Opt-in `fallback` / `onError` for partial-degradation:
 * - When `fallback` is set in `options`, ANY error thrown during
 *   execution (loader, validation, guard, filter) is caught,
 *   `onError` is invoked with the error if provided, and the
 *   `fallback` value is returned in place of the loader's result.
 * - When `fallback` is NOT in `options`, errors propagate as before
 *   (back-compat). The presence of the key opts in - the value
 *   itself can be anything (empty array, sentinel object, even
 *   `null` or `undefined`).
 *
 * Apps wire `fallback` per-stream so a single failed loader on a
 * multi-stream page renders an empty placeholder rather than taking
 * down the entire `+page.server.js` `load()`.
 *
 * @param {string} path - RPC path (e.g. 'chat/messages')
 * @param {any[]} args - Arguments to pass (excluding ctx)
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ user?: any, fallback?: any, onError?: (err: any) => void }} [options]
 * @returns {Promise<any>}
 */
export async function __directCall(path, args, platform, options) {
	const hasFallback = options ? ('fallback' in options) : false;
	const fallback = hasFallback ? options.fallback : undefined;
	const onError = options && typeof options.onError === 'function' ? options.onError : null;

	_enterInFlight();
	try {
		const execution = { ctx: null };
		const result = await _runDirectCall(path, args, platform, options, execution);
		const failure = _responseFenceFailure(execution.ctx);
		if (failure) throw new LiveError(failure.code, failure.error);
		return result;
	} catch (err) {
		if (!hasFallback) throw err;
		emitOperationalEvent({
			source: 'svelte-realtime',
			component: 'server.direct-call',
			event: 'direct-call.fallback.used',
			severity: 'error',
			dataClass: 'application',
			message: 'A direct live-function call failed and returned its configured fallback.',
			attributes: { path, error: diagnosticError(err) }
		});
		if (onError) {
			try { onError(err); } catch {}
		}
		return fallback;
	} finally {
		_exitInFlight();
	}
}

async function _runDirectCall(path, args, platform, options, execution) {
	if (_isShuttingDown()) {
		// Reject new SSR loads during a drain. A caller that passed `fallback`
		// gets it (the page renders degraded); otherwise the load throws
		// UNAVAILABLE. __directCall counts this in-flight either way.
		throw new LiveError('UNAVAILABLE', 'Server is shutting down');
	}
	if (!_isLazyResolved()) await _resolveAllLazy();
	const registrationRevision = state.registrationRevision;
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		throw new LiveError('NOT_FOUND', `Live function '${path}' not found`);
	}

	// Distinguish "user explicitly passed (even as null)" from "user omitted".
	// Omitted + guarded stream is almost always a load() bug - throw a
	// descriptive Error so the SSR overlay surfaces the fix immediately.
	const userExplicit = options ? ('user' in options) : false;
	const userValue = userExplicit ? options.user : null;

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(userValue, null, platform, _h, null);
	execution.ctx = ctx;

	// Run global middleware chain, then guard, then execution
	// A direct call answers with what the middleware returns, so redacting,
	// caching and catch-and-default middleware keep working. Only a response
	// envelope is a wire answer, turned back into what `.load()` expects: its
	// data, or a LiveError so `fallback` and `onError` apply.
	let _chainValue;
	let _chainReturned = false;
	const _answer = await _runWithMiddleware(ctx, async () => {
		const value = await _directCallChain();
		_chainValue = value;
		_chainReturned = true;
		return value;
	});
	_assertRegistrationRevision(registrationRevision);
	if (_chainReturned && _answer === _chainValue) return _answer;
	if (_isEnvelope(_answer)) {
		if (_answer.ok === true) return _answer.data;
		const err = new LiveError(typeof _answer.code === 'string' ? _answer.code : 'INTERNAL_ERROR', typeof _answer.error === 'string' ? _answer.error : undefined, _answer);
		throw err;
	}
	return _answer;

	async function _directCallChain() {
	// Run module guard
	const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
	const guardFn = await _resolveGuard(modulePath);
	if (guardFn) {
		if (!userExplicit) {
			throw new Error(
				`[svelte-realtime] '${path}' has a guard but .load() was called without a user.\n` +
				`  Pass it explicitly:    stream.load(platform, { user: locals.user })\n` +
				`  Or opt into anonymous: stream.load(platform, { user: null })\n` +
				`  See: https://svti.me/ssr`
			);
		}
		await _runGuard(guardFn, ctx);
	}

	if (/** @type {any} */ (fn).__isStream) {
		const argsSchema = /** @type {any} */ (fn).__streamArgs;
		if (argsSchema) {
			const result = _validate(argsSchema, args);
			if (!result.ok) {
				const err = new LiveError('VALIDATION', result.message);
				/** @type {any} */ (err).issues = result.issues;
				throw err;
			}
			args = Array.isArray(result.data) ? result.data : args;
		}

		if (/** @type {any} */ (fn).__isGated) {
			const predicate = /** @type {any} */ (fn).__gatePredicate;
			// Await for parity with the wire-level path: an async predicate
			// that returns `false` would otherwise produce a truthy Promise
			// here and be treated as "allow".
			if (!(await predicate(ctx, ...args))) return null;
		}
		const streamFilter = /** @type {any} */ (fn).__streamFilter;
		if (streamFilter && !(await streamFilter(ctx, ...args))) {
			const code = _getAuthenticatedId(ctx) !== null ? 'FORBIDDEN' : 'UNAUTHENTICATED';
			throw new LiveError(code, code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied');
		}
		// Resolve the topic once so BOTH the loader-error handler and the
		// redaction fail-closed handler below can pass it to onError. (The
		// redact catch previously referenced an out-of-scope `topic`, throwing a
		// ReferenceError instead of failing closed.) Resolution errors are
		// swallowed - a best-effort label for onError.
		let topic;
		try {
			const rawTopic = /** @type {any} */ (fn).__streamTopic;
			topic = typeof rawTopic === 'function' ? _callTopicFn(rawTopic, ctx, args) : rawTopic;
		} catch {}
		let result;
		try {
			_assertRegistrationRevision(registrationRevision);
			result = await fn(ctx, ...args);
		} catch (err) {
			const streamOnError = /** @type {any} */ (fn).__streamOnError;
			if (streamOnError) {
				try { await streamOnError(err, ctx, topic); } catch {}
			}
			throw err;
		}
		const initTransform = /** @type {any} */ (fn).__streamTransform;
		if (initTransform && result != null) {
			// Match the WS subscribe path: paginated responses transform .data only.
			if (result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result) {
				result = { ...result, data: _applyInitTransform(initTransform, result.data) };
			} else {
				result = _applyInitTransform(initTransform, result);
			}
		}
		// PII redaction on the resume/unchanged egress, after transform. Mirrors
		// the paginated-vs-whole split above. Fail-closed: a throwing redactor
		// nulls the data rather than returning un-redacted resume payload.
		const initRedact = /** @type {any} */ (fn).__streamPiiRedact;
		if (initRedact && result != null) {
			try {
				if (result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result) {
					result = { ...result, data: initRedact(result.data) };
				} else {
					result = initRedact(result);
				}
			} catch (err) {
				const onErr = /** @type {any} */ (fn).__streamOnError;
				if (onErr) { try { onErr(err, ctx, topic); } catch {} }
				if (result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result) result = { ...result, data: null };
				else result = null;
			}
		}
		return result;
	}

	_assertRegistrationRevision(registrationRevision);
	return fn(ctx, ...args);
	}
}

/**
 * Ready-made message hook. Re-export from hooks.ws.js for zero-config
 * RPC routing.
 *
 * First call per platform installs the framework's publish wrap via
 * `_ensureWrap` (idempotent), so apps that wire `setBus(bus)` and
 * re-export `message` but never call `_activateDerived` /
 * `setCronPlatform` themselves still get cluster routing on first
 * RPC. Subsequent calls are no-ops on the wrap path. Without a bus,
 * the wrap's per-publish overhead is one function call plus a
 * `Map.has` check on an empty Map - well below noise.
 *
 * Signature matches the adapter's message hook exactly.
 *
 * @param {any} ws
 * @param {{ data: ArrayBuffer, platform: import('svelte-adapter-uws').Platform }} ctx
 */
export function message(ws, { data, platform, msg }) {
	_ensureWrap(platform);
	// Protocol-compat signal: a client advertises its baked protocol version once on
	// connect as { type: 'proto', v }. It is not an RPC, so handle it here and return
	// (it never reaches handleRpc). `msg` is the adapter's forwarded parse of a
	// control frame whose type matched none of the adapter's own; undefined on an
	// older adapter / binary / parse-miss, in which case a proto frame simply isn't
	// recognized (a no-op fall-through to handleRpc, which returns false for it).
	if (_maybeHandleProto(ws, msg, platform)) return;
	handleRpc(ws, data, platform);
}

/**
 * Create a custom message hook with options baked in.
 *
 * @param {{ platform?: (p: import('svelte-adapter-uws').Platform) => import('svelte-adapter-uws').Platform, beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void, onJsonMessage?: (ws: any, msg: any, platform: import('svelte-adapter-uws').Platform) => void, maxJsonDepth?: number, onUnhandled?: (ws: any, data: ArrayBuffer, platform: import('svelte-adapter-uws').Platform) => void }} [options]
 * @returns {(ws: any, ctx: { data: ArrayBuffer, msg?: any, platform: import('svelte-adapter-uws').Platform }) => void}
 */
export function createMessage(options) {
	if (!options) return message;

	const { platform: transformPlatform, beforeExecute, onError, onJsonMessage, onUnhandled } = options;
	const maxJsonDepth = (options && /** @type {any} */ (options).maxJsonDepth) || _DEFAULT_MAX_ENVELOPE_DEPTH;

	/** @type {any} */
	const rpcOpts = {};
	if (beforeExecute) rpcOpts.beforeExecute = beforeExecute;
	if (onError) rpcOpts.onError = onError;
	const hasRpcOpts = beforeExecute || onError;

	return function customMessage(ws, ctx) {
		const { data, platform } = ctx;
		// `msg` is forwarded by svelte-adapter-uws when it JSON-parsed the
		// frame for control-message routing but no control type matched.
		// Undefined on older adapter versions / binary / prefix-miss / parse-
		// fail / non-object. See svelte-adapter-uws MessageContext docs.
		const forwardedMsg = /** @type {any} */ (ctx).msg;
		// Install the framework's publish wrap on the platform (idempotent
		// per platform). After this returns, `platform.publish` is
		// `derivedPublish`, which is the single bus-routing site for the
		// whole framework. Done BEFORE any transform callback so the
		// callback sees the wrapped publish path (correct ordering for
		// non-bus transforms like metrics instrumentation; double-wrap
		// detected and warned for legacy bus.wrap callbacks).
		_ensureWrap(platform);
		let p;
		if (transformPlatform) {
			// Dev-only nudge: a `platform` callback against an
			// already-activated platform with a process-wide bus wired
			// almost always means a legacy `(p) => bus.wrap(p)` callback
			// is layered on top of `derivedPublish`'s inner bus.wrap,
			// which double-relays every RPC publish. Warn once per
			// process; users with a non-bus transform (e.g. metrics
			// instrumentation) can ignore.
			if (_IS_DEV
				&& !state.manualPlatformCallbackWarnFired
				&& _getBus()
			) {
				state.manualPlatformCallbackWarnFired = true;
				console.warn(
					"[svelte-realtime] createMessage({ platform: callback }) is redundant when `setBus(...)` is wired: " +
					"the framework already routes ctx.publish through the bus, so a manual `bus.wrap(p)` callback double-relays every RPC publish to other replicas. " +
					"Drop the `platform` option to fix. If your callback does a non-bus transform (e.g. metrics) you can ignore this warning.\n" +
					"  See: https://svti.me/cluster-relay"
				);
			}
			p = transformPlatform(platform);
		} else {
			p = platform;
		}
		// Protocol-compat signal, same as the default message() hook: a proto frame is
		// not an RPC and never reaches handleRpc / onJsonMessage. Intercept it here so
		// the signal works on the custom-hook (cluster / rate-limited) path too.
		if (_maybeHandleProto(ws, forwardedMsg, p)) return;
		const handled = handleRpc(ws, data, p, hasRpcOpts ? rpcOpts : undefined);
		if (handled) return;
		// A strict range mismatch contains custom JSON/plugin dispatch too. RPCs
		// above receive their typed PROTOCOL_MISMATCH response; untyped custom
		// envelopes are dropped after the same one-shot system notice.
		if (_protocolRejection(ws, p)) return;

		// JSON-envelope dispatch. Plugin-layer frames (cursor `{type:'cursor',...}`,
		// future presence-snapshot, typing indicators, etc.) reach a single
		// callback with the parsed value, so user wiring doesn't re-parse on
		// every frame.
		//
		// Two-tier lookup:
		// 1) Fast path - if the adapter already parsed for control routing,
		//    use the forwarded `msg` directly (one parse total).
		// 2) Fallback - if the adapter didn't forward (older adapter version,
		//    frame > 8 KiB, or first byte not `{"ty`), parse here.
		//
		// `exceedsEnvelopeDepth` mirrors `handleRpc`'s defense-in-depth against
		// host walkers; deeper-than-cap envelopes fall through to `onUnhandled`
		// with raw bytes so callers can log without crashing.
		//
		// The adapter's `maxPayloadLength` (default 1 MB) already bounds the
		// bytes `JSON.parse` ever sees - no separate size cap needed here.
		if (onJsonMessage) {
			/** @type {any} */
			let dispatchMsg;
			if (forwardedMsg !== undefined && forwardedMsg !== null && typeof forwardedMsg === 'object') {
				if (!exceedsEnvelopeDepth(forwardedMsg, maxJsonDepth)) {
					dispatchMsg = forwardedMsg;
				}
				// Adapter forwarded an envelope but depth busted -> skip fallback
				// (re-parsing the same bytes would produce the same too-deep object).
			} else if (data instanceof ArrayBuffer && data.byteLength >= 2) {
				const bytes = new Uint8Array(data);
				if (bytes[0] === 0x7B /* '{' */) {
					try {
						const parsed = JSON.parse(textDecoder.decode(data));
						if (parsed !== null && typeof parsed === 'object' && !exceedsEnvelopeDepth(parsed, maxJsonDepth)) {
							dispatchMsg = parsed;
						}
					} catch { /* fall through to onUnhandled */ }
				}
			}
			if (dispatchMsg !== undefined) {
				onJsonMessage(ws, dispatchMsg, p);
				return;
			}
		}

		if (onUnhandled) {
			onUnhandled(ws, data, p);
		}
	};
}
