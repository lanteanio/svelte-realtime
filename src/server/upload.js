// @ts-check
import { monotonicNow } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _IS_DEV } from './env.js';
import { _validPathRe } from './validate.js';
import { state } from './state.js';
import { _getCtxHelpers, _buildCtx } from './ctx.js';
import { _recordRpcMetrics } from './metrics.js';

const textDecoder = new TextDecoder();

// Seam: the guard / middleware / lazy-resolve / registry machinery stays in
// server.js (entangled with the registry + _globalMiddleware); the upload pump
// reaches it through these, injected at init.
let _resolveAllLazy, _resolveRegistryEntry, _resolveGuard, _runGuard, _runWithMiddleware;
export function installUpload(seams) {
	_resolveAllLazy = seams.resolveAllLazy;
	_resolveRegistryEntry = seams.resolveRegistryEntry;
	_resolveGuard = seams.resolveGuard;
	_runGuard = seams.runGuard;
	_runWithMiddleware = seams.runWithMiddleware;
}

// - Streaming uploads (live.upload) -----------------------------------------
//
// Wire format (client -> server):
//
//   Chunk frame (byte[0] = 0x01):
//     [0]      0x01 - chunk marker
//     [1]      flags
//                bit 0: hasArgs   (set on chunk 0 only)
//                bit 1: isLast
//                bits 2-7: reserved (must be 0)
//     [2..5]   streamId, big-endian uint32
//     [6..9]   seq, big-endian uint32 (0-indexed)
//     [10..]   if hasArgs:
//                [10..11] argsLen, big-endian uint16
//                [12..12+argsLen-1] argsJson UTF-8: { rpc: path, args: [...] }
//                [12+argsLen..] payload bytes
//              else:
//                [10..] payload bytes
//
//   Control frame (byte[0] = 0x02):
//     [0]      0x02 - control marker
//     [1]      ctrlType (0x10 = client cancel)
//     [2..5]   streamId
//     [6..]    type-specific payload
//
// Wire format (server -> client):
//   platform.send(ws, '__upload', streamIdHex, payload) where payload is one of:
//     { ok: true, data: <handler return> }
//     { ok: false, code, error }
//
// Per-chunk overhead is 10 bytes (12 + argsLen on chunk 0). For 64KB chunks
// that's 0.015% overhead.

export const _UPLOAD_FRAME_CHUNK = 0x01;
export const _UPLOAD_FRAME_CONTROL = 0x02;
const _UPLOAD_CTRL_CANCEL = 0x10;
const _UPLOAD_FLAG_HAS_ARGS = 0x01;
const _UPLOAD_FLAG_IS_LAST = 0x02;
const _UPLOAD_FLAG_RESERVED_MASK = 0xFC;

// Caps applied during the brief 'pending' window between chunk-0 arriving
// and the handler being resolved. Three boundaries on memory:
//   - _UPLOAD_PENDING_MAX_CHUNKS bounds queue depth for tiny chunks.
//   - _UPLOAD_PENDING_MAX_SIZE bounds total bytes per stream.
//   - state.UPLOAD_PENDING_MAX_AGGREGATE bounds total bytes across ALL streams
//     in the pending phase, so an attacker cannot multiply per-stream
//     caps by opening many concurrent connections / streamIds. Apps
//     with large legitimate concurrent uploads can raise it via
//     _setUploadCapsForTest in tests, or via a future runtime knob.
// Once the handler is resolved, per-handler caps in __uploadOptions take over.
const _UPLOAD_PENDING_MAX_CHUNKS = 64;
const _UPLOAD_PENDING_MAX_SIZE = 16 * 1024 * 1024;

/**
 * Per-WS upload registry. WeakMap so connections that GC before close()
 * don't leak entries.
 * @type {WeakMap<any, Map<number, any>>}
 */
const _wsUploads = new WeakMap();

/** Global counter for `maxConcurrentTotal` enforcement. */
let _totalActiveUploads = 0;

/**
 * Cached `platform.maxPayloadLength` from whichever adapter is in use.
 * Constant per-process, so we capture it the first time we see a platform
 * with the field. Piggybacked onto the first upload response per WS so
 * clients can compute an optimal chunk size automatically.
 */
let _uploadMaxFrameSize = 0;

/** Per-WS set: clients that have already received the `__cap` hint. */
const _informedAboutUploadCap = new WeakSet();

function _captureUploadMaxFrameSize(platform) {
	if (_uploadMaxFrameSize > 0) return;
	if (platform && typeof platform.maxPayloadLength === 'number' && platform.maxPayloadLength > 0) {
		_uploadMaxFrameSize = platform.maxPayloadLength;
	}
}

/** @internal Reset auto-discovery cache. Test-only. */
export function _resetUploadAutoDiscovery() {
	_uploadMaxFrameSize = 0;
}

function _streamIdHex(streamId) {
	return (streamId >>> 0).toString(16).padStart(8, '0');
}

function _respondUpload(ws, platform, streamId, payload) {
	_captureUploadMaxFrameSize(platform);
	let envelope = payload;
	let willInform = false;
	if (_uploadMaxFrameSize > 0 && !_informedAboutUploadCap.has(ws)) {
		envelope = { ...payload, __cap: _uploadMaxFrameSize };
		willInform = true;
	}
	try {
		platform.send(ws, '__upload', _streamIdHex(streamId), envelope);
		if (willInform) _informedAboutUploadCap.add(ws);
	} catch {
		// Closed connection - same swallow as _respond
	}
}

/**
 * Parse an upload chunk frame. Returns null if the frame is malformed.
 *
 * @param {ArrayBuffer} data
 */
function _parseUploadChunkFrame(data) {
	const byteLength = data.byteLength;
	if (byteLength < 10) return null;

	const view = new DataView(data);
	const flags = view.getUint8(1);

	// Reject any frame with reserved bits set so future versions can use them
	// without breaking old clients (clients should send 0 for unknown bits).
	if ((flags & _UPLOAD_FLAG_RESERVED_MASK) !== 0) return null;

	const hasArgs = (flags & _UPLOAD_FLAG_HAS_ARGS) !== 0;
	const isLast = (flags & _UPLOAD_FLAG_IS_LAST) !== 0;
	const streamId = view.getUint32(2, false);
	const seq = view.getUint32(6, false);

	// Stream-shape invariant: chunk 0 carries the args header, later chunks don't.
	if (seq === 0 && !hasArgs) return null;
	if (seq !== 0 && hasArgs) return null;

	let payloadOffset = 10;
	let argsHeader = null;

	if (hasArgs) {
		if (byteLength < 12) return null;
		const argsLen = view.getUint16(10, false);
		if (argsLen === 0) return null;
		payloadOffset = 12 + argsLen;
		if (byteLength < payloadOffset) return null;
		try {
			const argsJson = textDecoder.decode(new Uint8Array(data, 12, argsLen));
			argsHeader = JSON.parse(argsJson);
		} catch {
			return null;
		}
	}

	const payload = byteLength > payloadOffset ? data.slice(payloadOffset) : null;
	return { hasArgs, isLast, streamId, seq, argsHeader, payload };
}

/**
 * Parse an upload control frame. Returns null if malformed.
 *
 * @param {ArrayBuffer} data
 */
function _parseUploadControlFrame(data) {
	if (data.byteLength < 6) return null;
	const view = new DataView(data);
	return {
		ctrlType: view.getUint8(1),
		streamId: view.getUint32(2, false)
	};
}

/**
 * Create the async-iterable wrapper that the upload handler consumes via
 * `for await (const chunk of ctx.stream)`.
 *
 * Wires `ctrl.signal` so any abort (cancel, disconnect, cap exceeded)
 * causes a pending `next()` to reject and clears the queue.
 *
 * @param {AbortController} ctrl
 */
function _createUploadStream(ctrl) {
	/** @type {Uint8Array[]} */
	const queue = [];
	/** @type {{ resolve: Function, reject: Function } | null} */
	let pending = null;
	let done = false;
	/** @type {Error | null} */
	let error = null;

	function _resolveNext(value, isDone) {
		if (!pending) return;
		const r = pending; pending = null;
		r.resolve({ value, done: isDone });
	}
	function _rejectNext(err) {
		if (!pending) return;
		const r = pending; pending = null;
		r.reject(err);
	}

	function push(chunk) {
		if (done) return;
		if (pending) { _resolveNext(chunk, false); return; }
		queue.push(chunk);
	}

	function end() {
		if (done) return;
		done = true;
		if (pending && queue.length === 0) _resolveNext(undefined, true);
	}

	function abort(err) {
		if (done) return;
		done = true;
		error = err;
		queue.length = 0;
		_rejectNext(err);
	}

	const onAbort = () => {
		const reason = ctrl.signal.reason;
		const err = reason instanceof Error
			? reason
			: new LiveError('CANCELLED', typeof reason === 'string' ? reason : 'upload cancelled');
		abort(err);
	};
	if (ctrl.signal.aborted) onAbort();
	else ctrl.signal.addEventListener('abort', onAbort, { once: true });

	const stream = {
		next() {
			if (queue.length > 0) {
				return Promise.resolve({ value: queue.shift(), done: false });
			}
			if (error) return Promise.reject(error);
			if (done) return Promise.resolve({ value: undefined, done: true });
			return new Promise((resolve, reject) => { pending = { resolve, reject }; });
		},
		return() {
			done = true;
			queue.length = 0;
			_resolveNext(undefined, true);
			return Promise.resolve({ value: undefined, done: true });
		},
		throw(err) {
			abort(err);
			return Promise.reject(err);
		},
		[Symbol.asyncIterator]() { return this; }
	};

	return {
		stream,
		push,
		end,
		abort,
		get queueLength() { return queue.length; }
	};
}

/**
 * Release pre-handler-resolution bytes attributed to an upload back to
 * the aggregate accumulator. Idempotent: zeros _pendingAggBytes after
 * release so a second call is a no-op. Called on transition out of
 * the pending phase and on every cleanup path that might short-circuit
 * the normal pending -> running transition.
 */
function _releasePendingUploadBytes(upload) {
	if (!upload || !upload._pendingAggBytes) return;
	state.pendingUploadBytes = Math.max(0, state.pendingUploadBytes - upload._pendingAggBytes);
	upload._pendingAggBytes = 0;
}

/**
 * Remove an upload from the registry and decrement the global counter.
 * Idempotent.
 */
function _cleanupUpload(ws, perWs, streamId) {
	if (!perWs) return;
	const upload = perWs.get(streamId);
	if (!upload) return;
	_releasePendingUploadBytes(upload);
	perWs.delete(streamId);
	if (perWs.size === 0) _wsUploads.delete(ws);
	_totalActiveUploads = Math.max(0, _totalActiveUploads - 1);
}

/**
 * Synchronously create a pending upload entry. The entry is registered in the
 * per-WS map BEFORE the async start path begins so subsequent chunks arriving
 * during setup are queued (in `pendingChunks`) instead of dropped.
 *
 * Phase transitions: 'pending' -> 'running' (after handler resolved) -> 'settled'.
 * 'settled' is also reachable directly from 'pending' on capacity rejection,
 * disconnect, or cancellation before the handler starts.
 */
function _createUploadEntry(ws, perWs, streamId, platform) {
	/** @type {any} */
	const upload = {
		streamId,
		phase: 'pending',
		pendingChunks: [],
		expectedSeq: 0,
		bytesReceived: 0,
		options: null,
		streamWrap: null,
		ctrl: null,
		// Re-auth state. Populated by `_startUpload` once the guard has
		// resolved when `live.upload({ reauthEvery })` opt-in is set; left
		// unset (0 / null) for legacy uploads so the chunk pump's cheap
		// numeric check stays a single comparison on the hot path.
		_reauthEvery: 0,
		_reauthGuardFn: null,
		_reauthCtx: null,
		_lastReauthBytes: 0,
		_reauthInflight: null,
		fail(code, error) {
			if (upload.phase === 'settled') return;
			upload.phase = 'settled';
			if (upload.ctrl) {
				try { upload.ctrl.abort(new LiveError(code, error)); } catch {}
			}
			_respondUpload(ws, platform, streamId, { ok: false, code, error });
			_cleanupUpload(ws, perWs, streamId);
		}
	};
	return upload;
}

/**
 * Handle a 0x01 upload chunk frame.
 *
 * @param {any} ws
 * @param {ArrayBuffer} data
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: Function, onError?: Function }} [options]
 */
export function _handleUploadChunkFrame(ws, data, platform, options) {
	const parsed = _parseUploadChunkFrame(data);
	if (!parsed) {
		if (_IS_DEV) console.warn('[svelte-realtime] Malformed upload chunk frame; dropping\n  See: https://svti.me/uploads');
		return;
	}

	const { isLast, streamId, seq, argsHeader, payload } = parsed;
	let perWs = _wsUploads.get(ws);

	if (seq === 0) {
		if (perWs && perWs.has(streamId)) {
			_respondUpload(ws, platform, streamId, {
				ok: false, code: 'INVALID_REQUEST', error: 'streamId already active'
			});
			return;
		}
		// Aggregate pre-handler-resolution memory cap. Reject chunk-0
		// BEFORE allocating the pending entry so the registry does not
		// even hold a record of the rejected upload. Worst-case attack
		// pre-fix: N concurrent WS opening streamId 0 with a 16 MB
		// payload each = 16 * N MB held until a handler resolves, with
		// no handler-side cap able to fire. Post-fix: aggregate is
		// bounded by state.UPLOAD_PENDING_MAX_AGGREGATE regardless of N.
		const initialBytes = payload ? payload.byteLength : 0;
		if (state.pendingUploadBytes + initialBytes > state.UPLOAD_PENDING_MAX_AGGREGATE) {
			_respondUpload(ws, platform, streamId, {
				ok: false, code: 'OVERLOADED',
				error: 'pending-upload aggregate buffer cap exceeded; retry shortly'
			});
			return;
		}
		if (!perWs) { perWs = new Map(); _wsUploads.set(ws, perWs); }

		const upload = _createUploadEntry(ws, perWs, streamId, platform);
		upload.bytesReceived = initialBytes;
		upload.expectedSeq = 1;
		upload.pendingChunks.push({ payload, isLast });
		upload._pendingAggBytes = initialBytes;
		state.pendingUploadBytes += initialBytes;
		perWs.set(streamId, upload);
		_totalActiveUploads++;

		_startUpload(ws, perWs, streamId, upload, argsHeader, platform, options);
		return;
	}

	const upload = perWs?.get(streamId);
	if (!upload || upload.phase === 'settled') {
		// Late chunk for an upload that already finished or was cancelled.
		// Drop silently - common race when the handler returns early.
		return;
	}

	if (seq !== upload.expectedSeq) {
		upload.fail('INVALID_REQUEST', `out-of-order chunk: expected ${upload.expectedSeq}, got ${seq}`);
		return;
	}
	upload.expectedSeq = seq + 1;

	const payloadLen = payload ? payload.byteLength : 0;
	if (payloadLen > 0) upload.bytesReceived += payloadLen;

	if (upload.phase === 'pending') {
		// Bound memory while the handler is being resolved.
		if (upload.bytesReceived > _UPLOAD_PENDING_MAX_SIZE) {
			upload.fail('PAYLOAD_TOO_LARGE', 'upload exceeds limit during start');
			return;
		}
		if (upload.pendingChunks.length >= _UPLOAD_PENDING_MAX_CHUNKS) {
			upload.fail('FLOW_BACKPRESSURE', 'too many chunks queued during upload start');
			return;
		}
		// Aggregate cap also applies to follow-on chunks while pending.
		// upload.fail() releases the bytes via _releasePendingUploadBytes.
		if (state.pendingUploadBytes + payloadLen > state.UPLOAD_PENDING_MAX_AGGREGATE) {
			upload.fail('OVERLOADED', 'pending-upload aggregate buffer cap exceeded');
			return;
		}
		upload.pendingChunks.push({ payload, isLast });
		upload._pendingAggBytes += payloadLen;
		state.pendingUploadBytes += payloadLen;
		return;
	}

	// Running phase
	if (upload.bytesReceived > upload.options.maxSize) {
		upload.fail('PAYLOAD_TOO_LARGE', 'upload exceeds maxSize');
		return;
	}
	if (payloadLen > 0) {
		if (upload.streamWrap.queueLength >= upload.options.maxBufferedChunks) {
			upload.fail('FLOW_BACKPRESSURE', 'upload buffer overflow - handler not draining fast enough');
			return;
		}
		upload.streamWrap.push(new Uint8Array(payload));
	}
	// reauthEvery: re-run the module guard against the live ctx whenever
	// the upload crosses a configured byte threshold. The check is
	// fire-and-forget because the receive path is sync and the guard is
	// async; if the guard rejects, upload.fail aborts the stream and the
	// handler observes the abort signal. A re-auth already in flight is
	// honored to avoid running parallel guards on the same ctx (the most
	// recent one is what matters; the sync byte counter does the
	// scheduling).
	if (upload._reauthEvery > 0 && upload._reauthGuardFn && !upload._reauthInflight) {
		const sinceLast = upload.bytesReceived - upload._lastReauthBytes;
		if (sinceLast >= upload._reauthEvery) {
			upload._lastReauthBytes = upload.bytesReceived;
			upload._reauthInflight = (async () => {
				try {
					await _runGuard(upload._reauthGuardFn, upload._reauthCtx);
				} catch (err) {
					if (upload.phase !== 'settled') {
						const code = (err && /** @type {any} */ (err).code) || 'UNAUTHENTICATED';
						const msg = (err && /** @type {any} */ (err).message) || 'reauth failed';
						upload.fail(code, msg);
					}
				} finally {
					upload._reauthInflight = null;
				}
			})();
		}
	}
	if (isLast) upload.streamWrap.end();
}

/**
 * Handle a 0x02 upload control frame.
 *
 * @param {any} ws
 * @param {ArrayBuffer} data
 * @param {import('svelte-adapter-uws').Platform} platform
 */
export function _handleUploadControlFrame(ws, data, platform) {
	const parsed = _parseUploadControlFrame(data);
	if (!parsed) {
		if (_IS_DEV) console.warn('[svelte-realtime] Malformed upload control frame; dropping\n  See: https://svti.me/uploads');
		return;
	}

	const { ctrlType, streamId } = parsed;
	const perWs = _wsUploads.get(ws);
	const upload = perWs?.get(streamId);

	if (ctrlType === _UPLOAD_CTRL_CANCEL) {
		if (!upload || upload.phase === 'settled') return;
		upload.fail('CANCELLED', 'upload cancelled by client');
		return;
	}

	if (_IS_DEV) {
		console.warn(`[svelte-realtime] Unknown upload control type 0x${ctrlType.toString(16)} for stream ${_streamIdHex(streamId)}\n  See: https://svti.me/uploads`);
	}
}

/**
 * Resolve the registered live.upload handler, transition the upload from
 * 'pending' to 'running', drain queued chunks, and drive the handler with the
 * async-iterable. All response paths route through `upload.fail()` or the
 * success branch exactly once (guarded by `upload.phase`).
 *
 * @param {any} ws
 * @param {Map<number, any>} perWs
 * @param {number} streamId
 * @param {any} upload - pre-registered pending entry from _handleUploadChunkFrame
 * @param {any} argsHeader - parsed { rpc, args } from chunk 0
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: Function, onError?: Function }} [options]
 */
async function _startUpload(ws, perWs, streamId, upload, argsHeader, platform, options) {
	const _metricsStart = state.metricsInstruments ? monotonicNow() : 0;
	let path = '';
	/** @type {any} */ let ctx = null;

	try {
		if (!argsHeader || typeof argsHeader.rpc !== 'string') {
			_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
			upload.fail('INVALID_REQUEST', 'missing rpc path');
			return;
		}

		path = argsHeader.rpc;
		const args = Array.isArray(argsHeader.args) ? argsHeader.args : [];

		if (!_validPathRe.test(path)) {
			_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
			upload.fail('INVALID_REQUEST', 'Invalid path');
			return;
		}

		await _resolveAllLazy();
		if (upload.phase === 'settled') return;

		const fn = await _resolveRegistryEntry(path);
		if (upload.phase === 'settled') return;

		if (!fn) {
			_recordRpcMetrics(path, 'NOT_FOUND', _metricsStart);
			upload.fail('NOT_FOUND', 'Not found');
			return;
		}
		if (!/** @type {any} */ (fn).__isUpload) {
			_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
			upload.fail('INVALID_REQUEST', 'Not an upload endpoint');
			return;
		}

		const uploadOptions = /** @type {any} */ (fn).__uploadOptions;

		// Capacity caps. perWs and _totalActiveUploads already include this
		// upload, so subtract one to count "others".
		let othersInSession = 0;
		for (const e of perWs.values()) if (e !== upload) othersInSession++;
		if (othersInSession >= uploadOptions.maxConcurrentPerSession) {
			_recordRpcMetrics(path, 'TOO_MANY_UPLOADS', _metricsStart);
			upload.fail('TOO_MANY_UPLOADS', 'too many concurrent uploads on this session');
			return;
		}
		if (_totalActiveUploads - 1 >= uploadOptions.maxConcurrentTotal) {
			_recordRpcMetrics(path, 'TOO_MANY_UPLOADS', _metricsStart);
			upload.fail('TOO_MANY_UPLOADS', 'too many concurrent uploads');
			return;
		}
		if (upload.bytesReceived > uploadOptions.maxSize) {
			_recordRpcMetrics(path, 'PAYLOAD_TOO_LARGE', _metricsStart);
			upload.fail('PAYLOAD_TOO_LARGE', 'upload exceeds maxSize');
			return;
		}

		// Transition to running phase and create the live iterable.
		upload.options = uploadOptions;
		upload.ctrl = new AbortController();
		upload.streamWrap = _createUploadStream(upload.ctrl);
		upload.phase = 'running';

		// The bytes are now under the user's per-handler maxSize cap, not
		// the pre-handler aggregate cap. Release the aggregate accounting
		// here so other concurrent uploads can use the budget.
		_releasePendingUploadBytes(upload);

		// Drain chunks queued during the pending phase into the live stream.
		const drained = upload.pendingChunks;
		upload.pendingChunks = null;
		for (let i = 0; i < drained.length; i++) {
			const c = drained[i];
			if (c.payload && c.payload.byteLength > 0) {
				upload.streamWrap.push(new Uint8Array(c.payload));
			}
			if (c.isLast) upload.streamWrap.end();
		}

		const _h = _getCtxHelpers(platform);
		ctx = _buildCtx(ws.getUserData(), ws, platform, _h, null);
		ctx.stream = upload.streamWrap.stream;
		ctx.signal = upload.ctrl.signal;
		ctx.upload = { id: _streamIdHex(streamId) };

		await _runWithMiddleware(ctx, async () => {
			const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
			const guardFn = await _resolveGuard(modulePath);
			if (guardFn) await _runGuard(guardFn, ctx);

			// Capture guard + ctx for reauthEvery so the chunk pump can
			// re-run the same gate against the live ctx without re-resolving
			// the module path. Stored on the upload entry so the receive
			// path can fire it from a non-async context.
			if (uploadOptions.reauthEvery > 0 && guardFn) {
				upload._reauthGuardFn = guardFn;
				upload._reauthCtx = ctx;
				upload._reauthEvery = uploadOptions.reauthEvery;
				upload._lastReauthBytes = upload.bytesReceived;
			}

			if (options?.beforeExecute) {
				await options.beforeExecute(ws, path, args);
			}

			const result = await fn(ctx, ...args);
			if (upload.phase !== 'settled') {
				upload.phase = 'settled';
				_respondUpload(ws, platform, streamId, { ok: true, data: result });
			}
		});
		_recordRpcMetrics(path, '', _metricsStart);
	} catch (err) {
		if (upload.phase !== 'settled') {
			upload.phase = 'settled';
			const code = err instanceof LiveError ? err.code : 'INTERNAL_ERROR';
			_recordRpcMetrics(path || '__invalid__', code, _metricsStart);
			if (err instanceof LiveError) {
				_respondUpload(ws, platform, streamId, { ok: false, code: err.code, error: err.message });
			} else {
				if (options?.onError) {
					try { options.onError(path, err, ctx); } catch {}
				}
				if (_IS_DEV) console.error(`[svelte-realtime] Error in upload '${path}':`, err, '\n  See: https://svti.me/uploads');
				_respondUpload(ws, platform, streamId, { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
			}
		} else {
			_recordRpcMetrics(path || '__invalid__', err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart);
		}
		// Make sure any pending for-await wakes up if we exited via throw.
		if (upload.ctrl && !upload.ctrl.signal.aborted) {
			try { upload.ctrl.abort(err instanceof Error ? err : new Error(String(err))); } catch {}
		}
	} finally {
		_cleanupUpload(ws, perWs, streamId);
	}
}

/**
 * Drain in-flight uploads owned by `ws`. Called from `close()`.
 * Each upload's signal is aborted so the handler's `for await` wakes up
 * and any cleanup the user wired runs. No response is sent (the WS is closed).
 *
 * @param {any} ws
 */
export function _drainUploadsOnClose(ws) {
	const perWs = _wsUploads.get(ws);
	if (!perWs) return;
	for (const upload of perWs.values()) {
		if (upload.phase === 'settled') continue;
		upload.phase = 'settled';
		if (upload.ctrl) {
			try { upload.ctrl.abort(new LiveError('DISCONNECTED', 'connection closed')); } catch {}
		}
		_totalActiveUploads = Math.max(0, _totalActiveUploads - 1);
	}
	_wsUploads.delete(ws);
}
