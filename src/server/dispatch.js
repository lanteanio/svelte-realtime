// @ts-check
//
// The RPC dispatch nucleus: handleRpc + the guard/execute/respond/migrate chain,
// __directCall, and the message/createMessage hooks. The stateful staying machinery
// (subscription bookkeeping, registry/guard/lazy resolvers, middleware, shared
// validators) lives in server.js and is injected once at init via installDispatch.
import { assert } from '../shared/assert.js';
import { monotonicNow } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _IS_DEV } from './env.js';
import { _validPathRe, _DEFAULT_MAX_ENVELOPE_DEPTH, exceedsEnvelopeDepth } from './validate.js';
import { state, registry, guards, cronRegistry, _declaredRedact } from './state.js';
import { _getBus } from './bus.js';
import { _ensureWrap } from './reactive.js';
import { _getCtxHelpers, _buildCtx } from './ctx.js';
import { _consumeRateLimitBucket, _resolveRegistryRateLimit, _rateLimitConfig } from './rate-limit.js';
import { _recordRpcMetrics } from './metrics.js';
import { _shouldShed } from './admission.js';
import { _getIdentityKey } from './identity.js';
import { _bindAlarmCtx } from './alarm.js';
import { _registerReplayTopic } from './replay-routing.js';
import { _tenantTopic, _tenantKey } from './tenant.js';
import { _ownerClaimBegin, _ownerClaimResolve, _presenceClaimBegin, _presenceClaimResolve } from './room-owner.js';
import { _UPLOAD_FRAME_CHUNK, _UPLOAD_FRAME_CONTROL, _handleUploadChunkFrame, _handleUploadControlFrame } from './upload.js';
import { _isShuttingDown, _enterInFlight, _exitInFlight } from './lifecycle.js';

const textDecoder = new TextDecoder();

// Seam: stateful staying machinery (subscription bookkeeping, registry/guard/lazy
// resolvers, middleware, shared validators), injected once by server.js at init.
let _isLazyResolved, _trackStreamSub, _rollbackStreamSubscribe, _registerStaleWatch, _registerInvalidationWatch, _resolveRegistryEntry, _resolveGuard, _resolveAllLazy, _runWithMiddleware, _validate, _callTopicFn, _applyInitTransform;
export function installDispatch(seams) {
	_isLazyResolved = seams.isLazyResolved;
	_trackStreamSub = seams.trackStreamSub;
	_rollbackStreamSubscribe = seams.rollbackStreamSubscribe;
	_registerStaleWatch = seams.registerStaleWatch;
	_registerInvalidationWatch = seams.registerInvalidationWatch;
	_resolveRegistryEntry = seams.resolveRegistryEntry;
	_resolveGuard = seams.resolveGuard;
	_resolveAllLazy = seams.resolveAllLazy;
	_runWithMiddleware = seams.runWithMiddleware;
	_validate = seams.validate;
	_callTopicFn = seams.callTopicFn;
	_applyInitTransform = seams.applyInitTransform;
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
 * - `{ authenticated: true }` - throws UNAUTHENTICATED unless `ctx.user`
 *   is non-null. Cheaper to write than the equivalent function and harder
 *   to forget.
 *
 * Function-style middleware composes: `guard({ authenticated: true }, customCheck)`
 * runs the auth check first, then `customCheck(ctx)`. If any throws, the
 * chain stops. Bare-error throws are auto-classified to LiveError
 * (UNAUTHENTICATED if no user, FORBIDDEN otherwise) at the call site.
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
	if (!ctx || ctx.user == null) {
		throw new LiveError('UNAUTHENTICATED', 'Authentication required');
	}
}

/**
 * Run a per-module guard with auto-classification of non-LiveError throws.
 *
 * - LiveError thrown by the guard -> propagated as-is (caller-controlled
 *   code AND message reach the client).
 * - Bare Error / non-Error thrown -> wrapped as
 *   `LiveError(UNAUTHENTICATED, 'Authentication required')` when
 *   `ctx.user` is null, otherwise `LiveError(FORBIDDEN, 'Access denied')`.
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
		const code = ctx && ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
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
 * @returns {{ ok: false, code: string, error: string }}
 */
function _unknownPathReply(ws) {
	if (state.maskNotFound) {
		const user = typeof ws?.getUserData === 'function' ? ws.getUserData() : null;
		const code = user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
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
				if (typeof header.rpc === 'string' && typeof header.id === 'string') {
					const payload = data.slice(3 + headerLen);
					_executeBinaryRpc(ws, header, payload, platform, options);
					return true;
				}
			} catch (err) {
				if (_IS_DEV) {
					console.warn('[svelte-realtime] Failed to parse binary RPC header:', err, '\n  See: https://svti.me/binary');
				}
			}
		}
		return false;
	}

	// Upload chunk: byte[0] = 0x01 (live.upload streaming)
	if (bytes[0] === _UPLOAD_FRAME_CHUNK) {
		_handleUploadChunkFrame(ws, data, platform, options);
		return true;
	}

	// Upload control: byte[0] = 0x02 (cancel etc)
	if (bytes[0] === _UPLOAD_FRAME_CONTROL) {
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
		_executeBatch(ws, msg, platform, options);
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
		_executeVolatileRpc(ws, msg, platform, options);
		return true;
	}

	if (typeof msg.id !== 'string') return false;

	// envelope.shape invariant: rpc and id must be non-empty for routing
	assert(msg.rpc.length > 0 && msg.id.length > 0, 'realtime/handleRpc.envelope.non-empty', { rpcLen: msg.rpc.length, idLen: msg.id.length });

	// Validated as RPC - handle asynchronously, return true synchronously
	_executeRpc(ws, msg, platform, options);
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
	_respond(ws, platform, msg.id, result);
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
	if (_IS_DEV) {
		const path = msg.rpc;
		const fn = await _resolveRegistryEntry(path);
		if (fn && !_hasVolatileMarker(fn) && !_volatileWarnSet.has(path)) {
			if (_volatileWarnSet.size < _VOLATILE_WARN_CAP) _volatileWarnSet.add(path);
			console.warn(
				`[svelte-realtime] handler '${path}' received a fire-and-forget call but is not marked live.volatile(). ` +
				"Errors will be silently dropped (no reply is sent). Wrap the handler with live.volatile() to make this intent explicit.\n  See: https://svti.me/volatile"
			);
		}
	}
	/** @type {any} */ (msg).id = '__volatile';
	await _executeSingleRpc(ws, /** @type {any} */ (msg), platform, options);
	// No _respond - fire-and-forget contract.
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

	if (batch.length > 50) {
		_recordRpcMetrics('__batch__', 'INVALID_REQUEST', _batchMetricsStart);
		_respond(ws, platform, '__batch', {
			batch: [{ id: '', ok: false, code: 'INVALID_REQUEST', error: 'Batch exceeds maximum of 50 calls' }]
		});
		return;
	}

	if (!_isLazyResolved()) await _resolveAllLazy();

	/** @type {Array<{ id: string, ok: boolean, data?: any, code?: string, error?: string }>} */
	let results;

	if (sequential) {
		results = new Array(batch.length);
		for (let i = 0; i < batch.length; i++) {
			const call = batch[i];
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _batchMetricsStart);
				results[i] = { id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id' };
				continue;
			}
			results[i] = await _executeSingleRpc(ws, call, platform, options);
		}
	} else {
		results = await Promise.all(batch.map((call) => {
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _batchMetricsStart);
				return { id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id' };
			}
			return _executeSingleRpc(ws, call, platform, options);
		}));
	}

	_respond(ws, platform, '__batch', { batch: results });
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
 * @param {{ id: string, seq?: number, schemaVersion?: number, version?: any }} msg
 * @param {{ topic: any, claimTopic?: any }} subscribedRef
 * @returns {Promise<any>}
 */
async function _executeStreamRpc(ws, platform, fn, ctx, args, msg, subscribedRef) {
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

	const rawTopic = /** @type {any} */ (fn).__streamTopic;
	let topic = typeof rawTopic === 'function' ? _callTopicFn(rawTopic, ctx, streamArgs) : rawTopic;
	// The reserved-prefix guard runs on the LOGICAL topic (an app cannot subscribe
	// to a `__` system channel) before the tenant prefix is applied.
	if (typeof topic === 'string' && topic.startsWith('__')) {
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'Reserved topic prefix' };
	}
	// Tenant prefix once, here, at the boundary: from this point `topic` is the
	// WIRE topic, so subscribe bookkeeping, replay registration, the
	// subscribe/unsubscribe hooks, and the topic-keyed registries
	// (coalesce/transform/volatile/stale/invalidation, all registered below by
	// `topic`) are all keyed by the tenant-scoped string - and a publish, which
	// prefixes the same way, matches. Null tenant -> unchanged (zero cost).
	if (ctx.tenantId && typeof topic === 'string') topic = _tenantTopic(ctx.tenantId, topic);
	// First-joiner owner delivery: if this is an owner-room DATA stream, open the
	// per-socket claim barrier NOW - synchronously, in the batch's sync prefix,
	// before ANY loader body in this batch can run (the paired :owner stream's
	// loader among them). The data-join resolves it with the claimed owner; that
	// loader awaits it. Sequencing the value into the subscribe response is what
	// closes the race a timer could not (see room-owner.js).
	if (typeof topic === 'string' && /** @type {any} */ (fn).__hasOwner) _ownerClaimBegin(ws, topic);
	// Same sequencing for a presence room's DATA stream: the paired :presence
	// loader awaits the joiner's own roster entry off the data-join, so the
	// barrier must be open before any loader body in this batch runs.
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
		_bindAlarmCtx(ctx, { wireTopic: topic, onAlarm: streamOpts.alarm.onAlarm, path: msg.rpc, tenantId: ctx.tenantId, misfireMs: streamOpts.alarm.misfireMs });
	}
	const replayOpts = /** @type {any} */ (fn).__replay;
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

	const streamFilter = /** @type {any} */ (fn).__streamFilter;
	if (streamFilter && !(await streamFilter(ctx, ...streamArgs))) {
		_settleClaimBarriers(ws, topic, fn);
		const code = ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
		return { id, ok: false, code, error: code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied' };
	}

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
	let _subscribeDenial = null;
	try {
		if (typeof platform.subscribe === 'function') {
			_subscribeDenial = await platform.subscribe(ws, topic);
		} else {
			ws.subscribe(topic);
		}
	} catch {
		_settleClaimBarriers(ws, topic, fn);
		return { id, ok: false, code: 'CONNECTION_CLOSED', error: 'WebSocket closed' };
	}
	if (_subscribeDenial) {
		_settleClaimBarriers(ws, topic, fn);
		return { id, ok: false, code: _subscribeDenial, error: _subscribeDenial === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied' };
	}
	_trackStreamSub(ws, topic, fn);
	subscribedRef.topic = topic;

	if (/** @type {any} */ (fn).__onSubscribe) {
		// `streamArgs` (3rd arg) lets a room enumeration registry capture the
		// room-identifying args of the topic that just gained a subscriber; the
		// presence hook ignores it.
		try { await /** @type {any} */ (fn).__onSubscribe(ctx, topic, streamArgs); } catch {}
	}
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

	if (/** @type {any} */ (fn).__isDerived && !state.activateDerivedCalled && !state.warnedActivateDerived) {
		if (_IS_DEV) {
			state.warnedActivateDerived = true;
			console.warn('[svelte-realtime] live.derived() subscribed but _activateDerived(platform) was never called. Derived streams will not receive live updates.\n  Call _activateDerived(platform) in your WebSocket open hook.\n  See: https://svti.me/derived');
		}
	}

	// Channel fast-path
	if (/** @type {any} */ (fn).__isChannel) {
		const emptyValue = streamOpts.merge === 'set' ? null : [];
		return { id, ok: true, data: emptyValue, topic, merge: streamOpts.merge, key: streamOpts.key, max: streamOpts.max, channel: true };
	}

	// Delta sync
	const deltaOpts = /** @type {any} */ (fn).__delta;
	const clientVersion = msg.version;
	if (deltaOpts && clientVersion !== undefined && deltaOpts.version && deltaOpts.diff) {
		try {
			const currentVersion = await deltaOpts.version();
			if (currentVersion === clientVersion) {
				return { id, ok: true, data: [], topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, unchanged: true, version: currentVersion };
			}
			let diff = await deltaOpts.diff(clientVersion);
			if (diff !== null && diff !== undefined) {
				// piiRedact on the user-bridged delta egress (this diff is computed
				// fresh by the app, not served from the redacted replay buffer). A
				// redactor throw is caught by the enclosing try and falls through to
				// the loader - fail-closed, never returning raw diff.
				const _redact = /** @type {any} */ (fn).__streamPiiRedact;
				if (_redact) diff = _redact(diff);
				return { id, ok: true, data: diff, topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, delta: true, version: currentVersion };
			}
		} catch {}
	}

	// Replay (bounded recent buffer)
	if (replayOpts && typeof clientSeq === 'number' && platform.replay) {
		try {
			const missed = await platform.replay.since(topic, clientSeq);
			if (missed) {
				const currentSeq = await platform.replay.seq(topic);
				return { id, ok: true, data: missed, topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, seq: currentSeq, replay: true };
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
			if (Array.isArray(missed) && missed.length > 0) {
				const currentSeq = await platform.replay.seq(topic);
				return { id, ok: true, data: missed, topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, seq: currentSeq, replay: true };
			}
		} catch {}
	}

	// Seq-delta (user-provided bridge for older-than-buffer reconnects)
	if (deltaOpts && typeof deltaOpts.fromSeq === 'function' && typeof clientSeq === 'number') {
		try {
			let events = await deltaOpts.fromSeq(clientSeq);
			if (Array.isArray(events)) {
				// piiRedact on the user-bridged seq-delta egress (these events come
				// from the app's fromSeq bridge, not the redacted replay buffer).
				// Fail-closed via the enclosing try; seq fields are preserved (not
				// matched by the sensitive-key set).
				const _redact = /** @type {any} */ (fn).__streamPiiRedact;
				if (_redact) events = _redact(events);
				let respSeq;
				if (events.length > 0) {
					const last = events[events.length - 1];
					if (last && typeof last.seq === 'number') respSeq = last.seq;
				}
				if (respSeq === undefined && platform.replay) {
					try { respSeq = await platform.replay.seq(topic); } catch {}
				}
				const deltaResp = {
					id, ok: true, data: events, topic,
					merge: streamOpts.merge, key: streamOpts.key,
					prepend: streamOpts.prepend, max: streamOpts.max,
					replay: true
				};
				if (respSeq !== undefined) deltaResp.seq = respSeq;
				return deltaResp;
			}
		} catch {}
	}

	let result;
	try {
		result = await fn(ctx, ...streamArgs);
	} catch (err) {
		const streamOnError = /** @type {any} */ (fn).__streamOnError;
		if (streamOnError) {
			try { await streamOnError(err, ctx, topic); } catch {}
		}
		throw err;
	}

	// Arm the staleness watchdog now that the loader succeeded.
	// Idempotent per topic, so multi-subscriber streams only ever
	// run one watchdog regardless of how many subscribers join.
	if (/** @type {any} */ (fn).__streamStaleAfterMs) {
		_registerStaleWatch(topic, fn, ctx, streamArgs, platform);
	}

	// Arm the topic-invalidation watcher(s). Same first-wins
	// idempotence story as the stale watchdog - duplicate
	// (pattern, topic) registrations are a no-op inside
	// _registerInvalidationWatch.
	if (/** @type {any} */ (fn).__streamInvalidateOn) {
		_registerInvalidationWatch(topic, fn, ctx, streamArgs, platform);
	}

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

	// Schema migration
	const serverVersion = /** @type {any} */ (fn).__streamVersion;
	const migrateFns = /** @type {any} */ (fn).__streamMigrate;
	if (serverVersion !== undefined && migrateFns && typeof clientSchemaVersion === 'number' && clientSchemaVersion < serverVersion) {
		resultData = _migrateData(resultData, clientSchemaVersion, serverVersion, migrateFns);
	}

	const response = {
		id, ok: true, data: resultData, topic, merge: streamOpts.merge,
		key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max,
		hasMore: undefined, cursor: undefined, seq: undefined,
		version: undefined, schemaVersion: undefined, replay: undefined,
		derived: /** @type {any} */ (fn).__isDerived || undefined
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
 * @returns {Promise<{ id: string, ok: boolean, data?: any, code?: string, error?: string }>}
 */
/**
 * Graceful-shutdown wrapper around the RPC funnel (text + volatile + batch +
 * the stream-subscribe branch all flow through here). Once a drain has begun,
 * new calls are rejected with `UNAVAILABLE` and are NOT counted in-flight (they
 * return immediately); every accepted call is counted so `onShutdown`'s drain
 * waits for it to settle. Counting happens before the first `await` so there is
 * no gap between the gate check and the in-flight increment.
 */
async function _executeSingleRpc(ws, msg, platform, options) {
	if (_isShuttingDown()) {
		return { id: msg.id, ok: false, code: 'UNAVAILABLE', error: 'Server is shutting down' };
	}
	_enterInFlight();
	try {
		return await _executeSingleRpcInner(ws, msg, platform, options);
	} finally {
		_exitInFlight();
	}
}

async function _executeSingleRpcInner(ws, msg, platform, options) {
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

	const args = rawArgs || [];
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		if (_IS_DEV) {
			console.warn(`[svelte-realtime] RPC call to '${path}' - no such live function registered\n  See: https://svti.me/rpc`);
		}
		// Fold the unregistered (client-controlled) path to a bounded label - an
		// unauthenticated caller must not be able to allocate a metric series per
		// distinct unknown path. See metrics.js for the length backstop.
		_recordRpcMetrics('__unknown__', 'NOT_FOUND', _metricsStart);
		return { id, ..._unknownPathReply(ws) };
	}

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(ws.getUserData(), ws, platform, _h, clientCursor !== undefined ? clientCursor : null, msg.idempotencyKey);
	const _subscribedRef = { topic: null, claimTopic: null };

	try {
		const _result = await _runWithMiddleware(ctx, async () => {
		const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
		const guardFn = await _resolveGuard(modulePath);
		if (guardFn) await _runGuard(guardFn, ctx);

		if (options?.beforeExecute) {
			await options.beforeExecute(ws, path, args);
		}

		if (isStream && /** @type {any} */ (fn).__isStream) {
			return await _executeStreamRpc(ws, platform, fn, ctx, args, msg, _subscribedRef);
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
			const result = await fn(ctx, ...args);
			return { id, ok: true, data: result };
		}
		}); // end _runWithMiddleware
		// Deprecation signal (live.deprecate): one-shot per (ws, path), attached to
		// the first ok response so the client warns once. Covers text/batch/
		// stream-subscribe (all flow through here); binary RPC attaches its own.
		// Skip fire-and-forget calls (id '__volatile', set in _executeVolatileRpc):
		// no response is sent, so consuming the one-shot would silently swallow it
		// and starve a later real call to the same deprecated path.
		if (_result && _result.ok !== false && id !== '__volatile') {
			const dep = _deprecationSignal(ws, path, fn);
			if (dep) /** @type {any} */ (_result).deprecation = dep;
		}
		_recordRpcMetrics(path, (_result && _result.ok === false) ? (_result.code || 'UNKNOWN') : '', _metricsStart, ws);
		return _result;
	} catch (err) {
		if (_subscribedRef.topic) _rollbackStreamSubscribe(ws, _subscribedRef.topic, fn, ctx);
		// A throw that escaped after the claim barriers opened but before the
		// happy-path settle (the guard `__streamFilter` throws, an internal
		// bookkeeping failure) would leave a paired :owner/:presence loader in this
		// batch - and any later lone sub-stream subscribe on this socket - awaiting
		// a claim that never resolves. Settle to null here (cleared on the happy
		// path, so this only fires on that pre-settle throw window).
		if (_subscribedRef.claimTopic) _settleClaimBarriers(ws, _subscribedRef.claimTopic, fn);
		_recordRpcMetrics(path, err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart, ws);
		if (err instanceof LiveError) {
			/** @type {any} */
			const result = { id, ok: false, code: err.code, error: err.message };
			if (/** @type {any} */ (err).issues) result.issues = /** @type {any} */ (err).issues;
			return result;
		}
		if (options?.onError) {
			try { options.onError(path, err, ctx); } catch {}
		}
		if (_IS_DEV) {
			console.warn(
				`[svelte-realtime] '${path}' threw a non-LiveError:`,
				err,
				'\nUse throw new LiveError(code, message) for client-visible errors. Raw errors are hidden from clients.\n  See: https://svti.me/errors'
			);
			console.error(`[svelte-realtime] Error in '${path}':`, err);
		}
		return { id, ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' };
	}
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
	if (_isShuttingDown()) {
		_respond(ws, platform, header.id, { ok: false, code: 'UNAVAILABLE', error: 'Server is shutting down' });
		return;
	}
	_enterInFlight();
	try {
		await _executeBinaryRpcInner(ws, header, payload, platform, options);
	} finally {
		_exitInFlight();
	}
}

async function _executeBinaryRpcInner(ws, header, payload, platform, options) {
	const { rpc: path, id, args: extraArgs } = header;
	const _metricsStart = state.metricsInstruments ? monotonicNow() : 0;

	if (!_validPathRe.test(path)) {
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'Invalid path' });
		return;
	}

	if (extraArgs !== undefined && !Array.isArray(extraArgs)) {
		// Pre-registry (path not yet resolved), so it may be unregistered and
		// client-controlled: fold to a bounded label rather than record the raw path.
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' });
		return;
	}

	if (!_isLazyResolved()) await _resolveAllLazy();
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		// Fold the unregistered (client-controlled) path to a bounded label - an
		// unauthenticated caller must not be able to allocate a metric series per
		// distinct unknown path. See metrics.js for the length backstop.
		_recordRpcMetrics('__unknown__', 'NOT_FOUND', _metricsStart);
		_respond(ws, platform, id, _unknownPathReply(ws));
		return;
	}

	if (!/** @type {any} */ (fn).__isBinary) {
		_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'Not a binary endpoint' });
		return;
	}

	const maxBinarySize = /** @type {any} */ (fn).__maxBinarySize || 10485760;
	if (payload.byteLength > maxBinarySize) {
		_recordRpcMetrics(path, 'PAYLOAD_TOO_LARGE', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'Binary payload exceeds size limit' });
		return;
	}

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(ws.getUserData(), ws, platform, _h, null);

	try {
		await _runWithMiddleware(ctx, async () => {
			const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
			const guardFn = await _resolveGuard(modulePath);
			if (guardFn) await _runGuard(guardFn, ctx);

			if (options?.beforeExecute) {
				await options.beforeExecute(ws, path, [payload, ...(extraArgs || [])]);
			}

			const result = await fn(ctx, payload, ...(extraArgs || []));
			/** @type {any} */
				const _resp = { ok: true, data: result };
				const _dep = _deprecationSignal(ws, path, fn);
				if (_dep) _resp.deprecation = _dep;
				_respond(ws, platform, id, _resp);
		});
		_recordRpcMetrics(path, '', _metricsStart, ws);
	} catch (err) {
		_recordRpcMetrics(path, err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart, ws);
		if (err instanceof LiveError) {
			_respond(ws, platform, id, { ok: false, code: err.code, error: err.message });
		} else {
			if (options?.onError) {
				try { options.onError(path, err, ctx); } catch {}
			}
			if (_IS_DEV) {
				console.error(`[svelte-realtime] Error in binary '${path}':`, err, '\n  See: https://svti.me/binary');
			}
			_respond(ws, platform, id, { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
		}
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
			console.warn(`[svelte-realtime] Missing migration function for version ${v} -> ${v + 1}\n  See: https://svti.me/schema`);
		}
	}
	return result;
}

function _respond(ws, platform, correlationId, payload) {
	if (_IS_DEV) {
		// Estimate size without double-serialization.
		const data = payload.data;
		if ((Array.isArray(data) && data.length > 5000) || (typeof data === 'string' && data.length > 800_000)) {
			console.warn(
				`[svelte-realtime] RPC response for '${correlationId}' contains ${data.length} items - ` +
				"large responses may exceed maxPayloadLength (default 1 MB; raise `websocket.maxPayloadLength` in svelte.config.js if needed).\n  See: https://svti.me/adapter-config"
			);
		}
	}
	try {
		const result = platform.send(ws, '__rpc', correlationId, payload);
		if (result === 0 && _IS_DEV) {
			console.warn(
				`[svelte-realtime] RPC response was not delivered (backpressure or closed connection)`
			);
		}
	} catch (err) {
		// uWS throws when accessing a closed WebSocket - expected during mid-RPC disconnect.
		if (_IS_DEV) {
			console.warn(`[svelte-realtime] RPC response for '${correlationId}' could not be delivered (client likely disconnected)`);
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
		return await _runDirectCall(path, args, platform, options);
	} catch (err) {
		if (!hasFallback) throw err;
		if (onError) {
			try { onError(err); } catch {}
		}
		return fallback;
	} finally {
		_exitInFlight();
	}
}

async function _runDirectCall(path, args, platform, options) {
	if (_isShuttingDown()) {
		// Reject new SSR loads during a drain. A caller that passed `fallback`
		// gets it (the page renders degraded); otherwise the load throws
		// UNAVAILABLE. __directCall counts this in-flight either way.
		throw new LiveError('UNAVAILABLE', 'Server is shutting down');
	}
	if (!_isLazyResolved()) await _resolveAllLazy();
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

	// Run global middleware chain, then guard, then execution
	return _runWithMiddleware(ctx, async () => {
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
			const code = ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
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

	return fn(ctx, ...args);
	});
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
