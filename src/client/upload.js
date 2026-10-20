// @ts-check
import { now, setTimer, microtask } from '../client-runtime.js';
import { clientState, RpcError, _textEncoder, _isDev, pendingUploads } from './internal-state.js';
import { _conn, ensureDisconnectListener } from './connection.js';

// - Streaming uploads (live.upload) -----------------------------------------
//
// Wire format mirrors the server side:
//
//   Chunk frame (client -> server):
//     [0]      0x01 - chunk marker
//     [1]      flags  (bit 0: hasArgs, bit 1: isLast, bits 2-7: reserved=0)
//     [2..5]   streamId, big-endian uint32
//     [6..9]   seq, big-endian uint32 (0-indexed, contiguous)
//     [10..]   if hasArgs:
//                [10..11] argsLen, big-endian uint16
//                [12..12+argsLen-1] argsJson UTF-8: { path, args? } with
//                                   receiver credits, { rpc, args? } without
//                [12+argsLen..] payload bytes
//              else:
//                [10..] payload bytes
//
//   Cancel frame (client -> server):
//     [0]      0x02
//     [1]      0x10 (cancel)
//     [2..5]   streamId
//
// Server -> client uses platform.send(ws, '__upload', streamIdHex, payload)
// where streamIdHex is the 8-char hex of the uint32 streamId. Payload is
// { ok: true, data }, { ok: false, code, error }, or the nonterminal credit
// grant { flow: 1, creditEnd }. docs/upload-wire.md is the full contract.
//
// Receiver credits: chunk 0 goes out at once, then the sender waits for the
// first grant and never sends a seq at or past the largest creditEnd seen.
// A server without credit support rejects the `path` header with
// INVALID_REQUEST 'missing rpc path' before any lookup or guard runs; the
// upload then restarts with the `rpc` header, and later uploads on that
// socket skip the attempt.

/** Default wire-frame size in bytes when neither user-configured nor
 * server-discovered. Tuned to fit under `svelte-adapter-uws`'s old default
 * `maxPayloadLength` (16KB) with room for the frame header and args JSON.
 * Discovery via the server's `__cap` hint upgrades this automatically: the
 * server attaches it to the first RPC or upload response on a connection.
 *
 * "Frame size" is the maximum wire frame bytes the framework will emit;
 * payload bytes per chunk are derived by subtracting envelope overhead
 * (10 bytes on chunks 1+, `12 + argsLen` on chunk 0). */
const _DEFAULT_UPLOAD_FRAME_SIZE = 12 * 1024;

/** Per-chunk envelope overhead. Chunks 1+ are 10 bytes (frame header).
 * Chunk 0 is 12 bytes (frame header + argsLen uint16) plus the args JSON
 * itself (`argsLen` bytes). Pre-fix, the chunk size knob was used as raw
 * payload bytes per chunk: `frame = chunkSize + overhead` could overflow
 * the adapter's `maxPayloadLength` cap, and the adapter closed the
 * connection with code 1009. Post-fix, the knob is the frame size and
 * the framework subtracts overhead per chunk -- no overflow possible. */
const _UPLOAD_FRAME_HEADER_BYTES = 10;
const _UPLOAD_FRAME_HEADER_WITH_ARGS_BYTES = 12;

/** High-water mark for the WS send queue, in bytes. When `conn.bufferedAmount`
 * (svelte-adapter-uws/client next.19+) exceeds this, the upload pump pauses
 * sending new chunks until the queue drops below `_DEFAULT_UPLOAD_LOW_WATER_MARK`.
 * Keeps the browser send buffer bounded regardless of file size. */
const _DEFAULT_UPLOAD_HIGH_WATER_MARK = 4 * 1024 * 1024;
const _DEFAULT_UPLOAD_LOW_WATER_MARK = 1 * 1024 * 1024;
const _UPLOAD_DRAIN_POLL_MS = 50;

/** @type {boolean} Dev-warn dedup: clamp-against-adapter-cap warning. */
let _uploadFrameSizeClampWarned = false;
/** @type {boolean} Dev-warn dedup: deprecated `chunkSize` field warning. */
let _uploadChunkSizeDeprecatedWarned = false;

/**
 * Compute the upload frame size (max wire frame bytes per chunk). Priority:
 *   1. User-configured `configure({ upload: { frameSize } })` (or the
 *      deprecated alias `chunkSize`) -- clamped to the discovered cap.
 *   2. Auto-discovered: the server's `maxPayloadLength`, used as-is. The
 *      framework subtracts envelope overhead per chunk; no 0.9 safety
 *      factor is needed because frame size IS the cap.
 *   3. Conservative default `_DEFAULT_UPLOAD_FRAME_SIZE` (12KB) -- only
 *      used until the connection's first response announces the cap.
 *
 * Re-evaluated for every chunk, so an upload started before the cap was
 * known switches to it as soon as the first credit grant carries it.
 *
 * **Hard invariant:** the returned frame size never exceeds the discovered
 * adapter cap. User input above the cap is silently clamped down with a
 * one-time dev-mode warning. The adapter would close the connection with
 * code 1009 if any frame exceeded its cap, so the framework enforces this
 * ceiling structurally rather than trusting user input.
 *
 * @returns {number}
 */
function _computeUploadFrameSize() {
	const cfg = clientState.config.upload;

	// Resolve the user-supplied value, preferring `frameSize` over the
	// deprecated `chunkSize` alias. Warn once per session if the deprecated
	// name is used so existing apps get a migration pointer in dev.
	/** @type {number | undefined} */
	let userFrameSize;
	if (cfg && typeof cfg.frameSize === 'number' && cfg.frameSize > 0) {
		userFrameSize = cfg.frameSize;
	} else if (cfg && typeof cfg.chunkSize === 'number' && cfg.chunkSize > 0) {
		userFrameSize = cfg.chunkSize;
		if (_isDev() && !_uploadChunkSizeDeprecatedWarned) {
			_uploadChunkSizeDeprecatedWarned = true;
			console.warn(
				"[svelte-realtime] configure({ upload: { chunkSize } }) is deprecated -- " +
				"rename to `frameSize`. The new name reflects the actual semantic: maximum " +
				"wire frame size, from which the framework subtracts envelope overhead " +
				"automatically. The value passes through unchanged."
			);
		}
	}

	const discoveredCap = clientState.uploadCap > 0 ? clientState.uploadCap : Infinity;

	if (userFrameSize !== undefined) {
		if (userFrameSize > discoveredCap) {
			if (_isDev() && !_uploadFrameSizeClampWarned) {
				_uploadFrameSizeClampWarned = true;
				console.warn(
					"[svelte-realtime] configure({ upload: { frameSize: " + userFrameSize + " } }) " +
					"exceeds the adapter's discovered maxPayloadLength (" + discoveredCap + " bytes); " +
					"clamping to the adapter cap. Without this clamp the adapter would close the " +
					"connection (code 1009). Either lower frameSize or raise the adapter's " +
					"`maxPayloadLength` config to match. Warned once per session."
				);
			}
			return discoveredCap;
		}
		return userFrameSize;
	}

	if (clientState.uploadCap > 0) return clientState.uploadCap;
	return _DEFAULT_UPLOAD_FRAME_SIZE;
}

/**
 * Derive the per-chunk payload size from a frame size and the chunk-0
 * args JSON length. The same payload size is used for every chunk in the
 * upload; chunk 0 fills its frame exactly (`payload + 12 + argsLen = frame`)
 * while chunks 1+ leave `2 + argsLen` bytes of frame budget unused. The
 * waste is ~0.01% on a 1MB-cap adapter with typical 100-byte args -- well
 * worth the simplicity of one chunk size for the whole upload.
 *
 * @param {number} frameSize
 * @param {number} argsLen
 * @returns {number}
 */
function _payloadSizeForFrame(frameSize, argsLen) {
	return Math.max(1, frameSize - _UPLOAD_FRAME_HEADER_WITH_ARGS_BYTES - argsLen);
}

/** @internal Reset auto-discovered state and warn dedup flags. Test-only. */
export function _resetUploadAutoDiscovery() {
	clientState.uploadCap = 0;
	clientState.uploadLegacy = false;
	_uploadFrameSizeClampWarned = false;
	_uploadChunkSizeDeprecatedWarned = false;
}

/** @type {boolean} */
let uploadListenerAttached = false;

/** Per-connection counter for client-assigned streamIds. uint32; skips 0
 * because `0` reads as the empty / "no streamId" sentinel in some debug
 * paths. Wraps cleanly past 2^32 via `>>> 0`. */
let _streamIdCounter = 0;
function _nextUploadStreamId() {
	_streamIdCounter = (_streamIdCounter + 1) >>> 0;
	if (_streamIdCounter === 0) _streamIdCounter = 1;
	return _streamIdCounter;
}

function _streamIdHexClient(streamId) {
	return (streamId >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a 0x01 chunk frame.
 *
 * @param {number} streamId
 * @param {number} seq
 * @param {boolean} isLast
 * @param {boolean} hasArgs
 * @param {string | null} argsJson - pre-serialised JSON header for chunk 0
 * @param {Uint8Array | null} payload
 * @returns {ArrayBuffer}
 */
function _encodeUploadChunkFrame(streamId, seq, isLast, hasArgs, argsJson, payload) {
	const argsBytes = hasArgs && argsJson ? _textEncoder.encode(argsJson) : null;
	const argsLen = argsBytes ? argsBytes.length : 0;
	const headerLen = hasArgs ? 12 + argsLen : 10;
	const payloadLen = payload ? payload.byteLength : 0;
	const totalLen = headerLen + payloadLen;

	const buf = new ArrayBuffer(totalLen);
	const u8 = new Uint8Array(buf);
	const view = new DataView(buf);
	view.setUint8(0, 0x01);
	let flags = 0;
	if (hasArgs) flags |= 0x01;
	if (isLast) flags |= 0x02;
	view.setUint8(1, flags);
	view.setUint32(2, streamId >>> 0, false);
	view.setUint32(6, seq >>> 0, false);
	if (hasArgs) {
		view.setUint16(10, argsLen, false);
		if (argsBytes) u8.set(argsBytes, 12);
		if (payload) u8.set(payload, 12 + argsLen);
	} else if (payload) {
		u8.set(payload, 10);
	}
	return buf;
}

/**
 * Build a 0x02 cancel control frame.
 * @param {number} streamId
 * @returns {ArrayBuffer}
 */
function _encodeUploadCancelFrame(streamId) {
	const buf = new ArrayBuffer(6);
	const view = new DataView(buf);
	view.setUint8(0, 0x02);
	view.setUint8(1, 0x10);
	view.setUint32(2, streamId >>> 0, false);
	return buf;
}

/**
 * Returns the total byte length of the source if known, otherwise undefined.
 * Used to drive `progress.total` and `progress.percent`.
 * @param {any} source
 * @returns {number | undefined}
 */
function _uploadSourceTotal(source) {
	if (typeof Blob !== 'undefined' && source instanceof Blob) return source.size;
	if (source instanceof ArrayBuffer) return source.byteLength;
	if (ArrayBuffer.isView(source)) return /** @type {ArrayBufferView} */ (source).byteLength;
	return undefined;
}

/**
 * Read any supported source in caller-sized pieces. `read(size)` resolves
 * `{ value, last }`: the next `size` bytes (fewer at the end, null for an
 * empty source) and whether nothing follows them. The size may differ per
 * read, so an upload adopts a frame cap announced after its first chunk.
 * `unread(bytes)` puts the most recent read back; `close()` releases a
 * ReadableStream's reader.
 *
 * Supported: `Blob` / `File`, `ArrayBuffer`, any `ArrayBufferView`,
 * `ReadableStream<Uint8Array>`. Throws `TypeError` for anything else.
 *
 * @param {any} source
 * @returns {{ read(size: number): Promise<{ value: Uint8Array | null, last: boolean }>, unread(bytes: Uint8Array): void, close(): void }}
 */
function _createUploadReader(source) {
	if (typeof Blob !== 'undefined' && source instanceof Blob) {
		let offset = 0;
		return {
			async read(size) {
				const end = Math.min(offset + size, source.size);
				const value = end > offset ? new Uint8Array(await source.slice(offset, end).arrayBuffer()) : null;
				offset = end;
				return { value, last: offset >= source.size };
			},
			unread(bytes) { offset -= bytes.byteLength; },
			close() {}
		};
	}
	/** @type {Uint8Array | null} */
	let bytes = null;
	if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
	else if (ArrayBuffer.isView(source)) {
		bytes = source instanceof Uint8Array
			? source
			: new Uint8Array(/** @type {any} */ (source).buffer, /** @type {any} */ (source).byteOffset, /** @type {any} */ (source).byteLength);
	}
	if (bytes) {
		const u8 = bytes;
		let offset = 0;
		return {
			async read(size) {
				const end = Math.min(offset + size, u8.byteLength);
				const value = end > offset ? u8.subarray(offset, end) : null;
				offset = end;
				return { value, last: offset >= u8.byteLength };
			},
			unread(chunk) { offset -= chunk.byteLength; },
			close() {}
		};
	}
	if (typeof ReadableStream !== 'undefined' && source instanceof ReadableStream) {
		return _createStreamUploadReader(source);
	}
	throw new TypeError('Unsupported upload source: expected Blob, File, ArrayBuffer, ArrayBufferView, or ReadableStream');
}

/**
 * Re-chunk a `ReadableStream<Uint8Array>` to the requested sizes. Buffers
 * across reads so the producer's chunk boundaries don't matter, and looks
 * one producer read ahead to tell whether a piece is the last.
 * @param {ReadableStream<any>} stream
 */
function _createStreamUploadReader(stream) {
	const reader = stream.getReader();
	/** @type {Uint8Array[]} */
	const pending = [];
	let pendingBytes = 0;
	let ended = false;

	async function pull() {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { ended = true; return; }
			if (!(value instanceof Uint8Array)) {
				throw new TypeError('ReadableStream must yield Uint8Array');
			}
			if (value.byteLength === 0) continue;
			pending.push(value);
			pendingBytes += value.byteLength;
			return;
		}
	}

	return {
		/** @param {number} size */
		async read(size) {
			while (pendingBytes < size && !ended) await pull();
			const n = Math.min(size, pendingBytes);
			/** @type {Uint8Array | null} */
			let value = null;
			if (n > 0 && pending[0].byteLength === n) {
				value = /** @type {Uint8Array} */ (pending.shift());
			} else if (n > 0) {
				value = new Uint8Array(n);
				let written = 0;
				while (written < n) {
					const head = pending[0];
					const remaining = n - written;
					if (head.byteLength <= remaining) {
						value.set(head, written);
						written += head.byteLength;
						pending.shift();
					} else {
						value.set(head.subarray(0, remaining), written);
						pending[0] = head.subarray(remaining);
						written += remaining;
					}
				}
			}
			pendingBytes -= n;
			if (pendingBytes === 0 && !ended) await pull();
			return { value, last: ended && pendingBytes === 0 };
		},
		/** @param {Uint8Array} chunk */
		unread(chunk) {
			pending.unshift(chunk);
			pendingBytes += chunk.byteLength;
		},
		close() {
			try { reader.releaseLock(); } catch { /* already released */ }
		}
	};
}

/**
 * Subscribe to the `__upload` topic exactly once. Routes incoming envelopes
 * to the matching pending handle by streamId.
 */
function ensureUploadListener() {
	if (uploadListenerAttached) return;
	const store = _conn().on('__upload');
	uploadListenerAttached = true;
	store.subscribe((envelope) => {
		if (!envelope) return;
		// Always update the auto-discovered cap, even for envelopes that
		// don't match a pending handle (late responses after cancel still
		// teach us the server's frame-size cap).
		const data = envelope.data;
		if (data && typeof data.__cap === 'number' && data.__cap > 0) {
			clientState.uploadCap = data.__cap;
		}
		const streamIdHex = envelope.event;
		const streamId = parseInt(streamIdHex, 16);
		if (!Number.isFinite(streamId)) return;
		const handle = pendingUploads.get(streamId);
		if (!handle) return;
		handle._onServerResponse(data);
	});
}

/**
 * Drive the chunk pump for one upload. Runs as a long-lived async function;
 * caller is `UploadHandle._start()` which wraps it in error handling.
 * @param {UploadHandle} handle
 */
async function _pumpUpload(handle) {
	const conn = _conn();
	const reader = _createUploadReader(handle._source);
	try {
		let seq = 0;
		while (!handle._cancelled && !handle._settled) {
			if (seq > 0) {
				if (handle._flow && seq >= handle._creditEnd) {
					const next = seq;
					await handle._waitFor(() => next < handle._creditEnd);
					if (handle._cancelled || handle._settled) return;
				}
				// Pace against the WS send queue as well. With
				// svelte-adapter-uws/client next.19+ `conn.bufferedAmount`
				// reflects the browser WebSocket's `bufferedAmount`; when it is
				// undefined (older adapter) this is a no-op.
				await _maybePaceUpload(handle, conn);
				if (handle._cancelled || handle._settled) return;
			}

			const { value, last } = await reader.read(_payloadSizeForFrame(_computeUploadFrameSize(), handle._argsLen));
			if (handle._cancelled || handle._settled) return;
			const bytes = value ? value.byteLength : 0;

			if (seq === 0 && handle._flow) {
				// Progress for chunk 0 waits for the server's first answer: a
				// server without credit support refuses it, and the upload
				// restarts from the same bytes.
				handle._unreported = bytes;
				_sendUploadChunk(conn, handle, 0, last, true, handle._argsJson, value);
				await handle._waitFor(() => handle._confirmed || handle._legacyRetry);
				if (handle._cancelled || handle._settled) return;
				if (handle._legacyRetry) {
					handle._legacyRetry = false;
					if (value) reader.unread(value);
					continue;
				}
			} else {
				_sendUploadChunk(conn, handle, seq, last, seq === 0, seq === 0 ? handle._argsJson : null, value);
				if (value) handle._trackProgress(bytes);
			}
			if (last) return;
			seq++;
		}
	} finally {
		reader.close();
	}
}

/**
 * Wait for the WS send queue to drop below the low-water mark before allowing
 * the pump to send the next chunk. Bails out immediately on cancel, settle,
 * or terminal close. No-op when the adapter doesn't expose `bufferedAmount`.
 *
 * @param {UploadHandle} handle
 * @param {any} conn
 */
async function _maybePaceUpload(handle, conn) {
	if (typeof conn.bufferedAmount !== 'number') return;
	const cfg = clientState.config.upload;
	const hi = cfg?.highWaterMark ?? _DEFAULT_UPLOAD_HIGH_WATER_MARK;
	if (conn.bufferedAmount <= hi) return;

	const lo = cfg?.lowWaterMark ?? _DEFAULT_UPLOAD_LOW_WATER_MARK;
	while (
		!handle._cancelled &&
		!handle._settled &&
		!clientState.terminated &&
		typeof conn.bufferedAmount === 'number' &&
		conn.bufferedAmount > lo
	) {
		await new Promise((r) => setTimer(r, _UPLOAD_DRAIN_POLL_MS));
	}
}

/**
 * Encode + send one chunk frame.
 * @param {any} conn
 * @param {UploadHandle} handle
 * @param {number} seq
 * @param {boolean} isLast
 * @param {boolean} hasArgs
 * @param {string | null} argsJson
 * @param {Uint8Array | null} payload
 */
function _sendUploadChunk(conn, handle, seq, isLast, hasArgs, argsJson, payload) {
	const frame = _encodeUploadChunkFrame(handle._streamId, seq, isLast, hasArgs, argsJson, payload);
	conn.sendQueued(frame);
}

/**
 * Handle returned by an upload call. Thenable (`await handle`), event
 * emitter (`handle.on('progress', ...)`), and abortable (`handle.cancel()`).
 *
 * Promise-shaped: `await handle` resolves with the server's return value
 * or rejects with `RpcError`. Codes seen at this layer:
 *   - `CANCELLED`            - caller cancelled (or AbortSignal aborted)
 *   - `DISCONNECTED`         - the connection dropped mid-upload
 *   - `CONNECTION_CLOSED`    - the connection closed for good, before or during the upload
 *   - `SOURCE_ERROR`         - the source iterator threw (filesystem, etc.)
 *   - any code from the server (`PAYLOAD_TOO_LARGE`, `NOT_FOUND`, ...)
 *
 * Events:
 *   - `progress` - { sent, total?, percent?, chunks, bytesPerSec }
 *   - `complete` - the server's return value
 *   - `error`    - the RpcError that caused rejection
 *   - `cancel`   - the cancel reason (only if cancelled, fires before `error`)
 */
class UploadHandle {
	/**
	 * @param {string} path
	 * @param {any} source
	 * @param {any[]} args
	 * @param {{ streamId: number, total: number | undefined }} options
	 */
	constructor(path, source, args, options) {
		this._path = path;
		this._source = source;
		this._args = args;
		this._streamId = options.streamId;
		this._total = options.total;
		// Chunk-0 header for the current mode; see `_setFlow`.
		this._argsJson = '';
		this._argsLen = 0;
		// Receiver credits: `_flow` while the server is expected to grant
		// them, `_creditEnd` the exclusive seq bound granted so far,
		// `_confirmed` once a grant arrived. `_legacyRetry` asks the pump to
		// resend chunk 0 without credits; `_unreported` holds chunk 0's
		// progress until the server answered.
		this._flow = false;
		this._creditEnd = 1;
		this._confirmed = false;
		this._legacyRetry = false;
		this._unreported = 0;
		/** @type {(() => void) | null} */
		this._wake = null;
		this._sent = 0;
		this._chunks = 0;
		/** @type {Map<string, Set<(payload: any) => void>>} */
		this._listeners = new Map();
		this._settled = false;
		this._cancelled = false;
		/** @type {any} */
		this._cancelReason = null;
		/** @type {{ t: number, bytes: number }[]} */
		this._rateSamples = [];

		/** @type {Promise<any>} */
		this._promise = new Promise((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
		// Unhandled-rejection guard: pre-attach a no-op catch so the user
		// doesn't get a warning if they only listen via `on('error', ...)`.
		this._promise.catch(() => {});

		pendingUploads.set(this._streamId, this);

		// Microtask-deferred start so users can attach listeners + set up
		// cancellation between `const h = avatar(file)` and the first chunk.
		microtask(() => this._start());
	}

	/** Bytes uploaded so far. */
	get sent() { return this._sent; }
	/** Total bytes if known (Blob/Buffer); undefined for ReadableStream. */
	get total() { return this._total; }
	/** Chunks sent so far. */
	get chunks() { return this._chunks; }
	/** 0..1 if total known; undefined otherwise. */
	get progress() {
		if (this._total == null) return undefined;
		if (this._total === 0) return 1;
		return this._sent / this._total;
	}
	/** Smoothed throughput over the last ~1s, in bytes/sec. */
	get bytesPerSec() {
		if (this._rateSamples.length === 0) return 0;
		const nowMs = now();
		let total = 0;
		for (const s of this._rateSamples) total += s.bytes;
		const span = Math.max(1, nowMs - this._rateSamples[0].t);
		return Math.round(total * 1000 / span);
	}
	/** Numeric streamId (uint32). Hex via `streamIdHex`. */
	get streamId() { return this._streamId; }
	/** 8-char hex matching server-side `ctx.upload.id`. */
	get streamIdHex() { return _streamIdHexClient(this._streamId); }

	/**
	 * Subscribe to a handle event. Returns an unsubscribe function.
	 * Events: 'progress', 'complete', 'error', 'cancel'.
	 * @param {'progress' | 'complete' | 'error' | 'cancel'} event
	 * @param {(payload: any) => void} callback
	 * @returns {() => void}
	 */
	on(event, callback) {
		let set = this._listeners.get(event);
		if (!set) { set = new Set(); this._listeners.set(event, set); }
		set.add(callback);
		return () => { set.delete(callback); };
	}

	/**
	 * Cancel the upload. Sends a control frame to the server (best-effort)
	 * and rejects the promise with `RpcError('CANCELLED')`. Idempotent.
	 *
	 * Compose with `AbortController`:
	 *   `ac.signal.addEventListener('abort', () => handle.cancel())`
	 *
	 * @param {string} [reason]
	 */
	cancel(reason) {
		if (this._settled) return;
		this._cancelled = true;
		this._cancelReason = reason;
		// A connection closed for good has no upload to cancel.
		if (!clientState.terminated) {
			try {
				const conn = _conn();
				conn.sendQueued(_encodeUploadCancelFrame(this._streamId));
			} catch { /* connection may be closed; server will discard the upload */ }
		}
		this._settle(false, new RpcError('CANCELLED', typeof reason === 'string' ? reason : 'upload cancelled'));
	}

	then(onFulfilled, onRejected) {
		return this._promise.then(onFulfilled, onRejected);
	}
	catch(onRejected) {
		return this._promise.catch(onRejected);
	}
	finally(onFinally) {
		return this._promise.finally(onFinally);
	}

	_emit(event, payload) {
		const set = this._listeners.get(event);
		if (!set) return;
		for (const cb of [...set]) {
			try { cb(payload); } catch (err) {
				if (typeof console !== 'undefined') {
					console.error(`[svelte-realtime] upload '${event}' listener threw:`, err, '\n  See: https://svti.me/uploads');
				}
			}
		}
	}

	/**
	 * Choose the chunk-0 header: `{ path, args? }` asks for receiver
	 * credits, `{ rpc, args? }` is the format servers without them accept.
	 * @param {boolean} flow
	 */
	_setFlow(flow) {
		this._flow = flow;
		const args = this._args.length > 0 ? this._args : undefined;
		this._argsJson = JSON.stringify(flow ? { path: this._path, args } : { rpc: this._path, args });
		this._argsLen = _textEncoder.encode(this._argsJson).length;
	}

	/**
	 * Resolve once `ready()` holds or the upload settled or was cancelled.
	 * @param {() => boolean} ready
	 */
	async _waitFor(ready) {
		while (!ready() && !this._settled && !this._cancelled) {
			await new Promise((resolve) => { this._wake = resolve; });
		}
	}

	_wakePump() {
		const wake = this._wake;
		this._wake = null;
		if (wake) wake();
	}

	_reportChunkZero() {
		const bytes = this._unreported;
		if (bytes === 0) return;
		this._unreported = 0;
		this._trackProgress(bytes);
	}

	_settle(ok, payload) {
		if (this._settled) return;
		this._settled = true;
		this._wakePump();
		pendingUploads.delete(this._streamId);
		if (ok) {
			this._emit('complete', payload);
			this._resolve(payload);
		} else {
			if (this._cancelled) this._emit('cancel', this._cancelReason);
			this._emit('error', payload);
			this._reject(payload);
		}
	}

	/** @param {{ ok?: boolean, data?: any, code?: string, error?: string, __cap?: number, flow?: number, creditEnd?: number }} envelope */
	_onServerResponse(envelope) {
		// Auto-discover server's frame-size cap, regardless of settled state
		// so late responses still update the cache for future uploads.
		if (envelope && typeof envelope.__cap === 'number' && envelope.__cap > 0) {
			clientState.uploadCap = envelope.__cap;
		}
		if (this._settled || !envelope) return;
		if (envelope.flow === 1) {
			if (!this._flow) return;
			const end = envelope.creditEnd;
			if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < 1) {
				this._abandon(new RpcError('INVALID_REQUEST', 'Invalid upload credit from server'));
				return;
			}
			this._confirmed = true;
			this._reportChunkZero();
			if (end > this._creditEnd) this._creditEnd = end;
			this._wakePump();
			return;
		}
		if (this._flow && !this._confirmed && envelope.ok === false
			&& envelope.code === 'INVALID_REQUEST' && envelope.error === 'missing rpc path') {
			// A server without receiver credits; nothing of this upload ran.
			clientState.uploadLegacy = true;
			this._unreported = 0;
			this._creditEnd = 1;
			this._setFlow(false);
			this._legacyRetry = true;
			this._wakePump();
			return;
		}
		if (envelope.ok) {
			this._reportChunkZero();
			this._settle(true, envelope.data);
		} else if (envelope) {
			const err = new RpcError(envelope.code || 'UNKNOWN', envelope.error || 'Upload failed', envelope);
			this._settle(false, err);
		}
	}

	/**
	 * Stop the upload locally and tell the server to drop it.
	 * @param {RpcError} err
	 */
	_abandon(err) {
		if (!clientState.terminated) {
			try { _conn().sendQueued(_encodeUploadCancelFrame(this._streamId)); } catch { /* closed; the server cleans up on close */ }
		}
		this._settle(false, err);
	}

	_onDisconnect() {
		if (this._settled) return;
		this._settle(false, new RpcError('DISCONNECTED', 'WebSocket connection lost'));
	}

	_trackProgress(bytes) {
		this._sent += bytes;
		this._chunks++;
		const nowMs = now();
		this._rateSamples.push({ t: nowMs, bytes });
		while (this._rateSamples.length > 0 && nowMs - this._rateSamples[0].t > 1000) {
			this._rateSamples.shift();
		}
		this._emit('progress', {
			sent: this._sent,
			total: this._total,
			percent: this.progress,
			chunks: this._chunks,
			bytesPerSec: this.bytesPerSec
		});
	}

	async _start() {
		if (this._settled) return;
		ensureDisconnectListener();
		if (clientState.terminated) {
			this._settle(false, new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
			return;
		}

		ensureUploadListener();
		this._setFlow(!clientState.uploadLegacy);

		try {
			await _pumpUpload(this);
		} catch (err) {
			if (this._settled) return;
			// Pump errored without a server response - typically a source-iter
			// failure (fs read, ReadableStream throw). Send a cancel so the
			// server doesn't keep waiting for chunks that won't arrive.
			if (!this._cancelled) {
				try {
					const conn = _conn();
					conn.sendQueued(_encodeUploadCancelFrame(this._streamId));
				} catch { /* closed; server cleans up via close hook */ }
			}
			const wrapped = err instanceof RpcError
				? err
				: new RpcError('SOURCE_ERROR', (err && err.message) ? err.message : String(err));
			this._settle(false, wrapped);
		}
	}
}

/**
 * Create a callable upload function for a given path. The returned function
 * takes `(source, ...args)` and returns an `UploadHandle`. Source is any
 * `Blob` / `File` / `ArrayBuffer` / `ArrayBufferView` / `ReadableStream`.
 *
 * Used by Vite-plugin-generated stubs and available for direct use:
 *
 * ```js
 * import { __upload } from 'svelte-realtime/client';
 * const avatar = __upload('routes/avatars/upload/avatar');
 *
 * const handle = avatar(file, 'cat.png', 'image/png');
 * handle.on('progress', (p) => bar.value = p.percent ?? 0);
 * const result = await handle;
 * ```
 *
 * @param {string} path
 * @returns {(source: any, ...args: any[]) => UploadHandle}
 */
export function __upload(path) {
	return function uploadCall(source, ...args) {
		// The chunk-0 header, and with it the payload size that keeps every
		// frame within the adapter's maxPayloadLength, is chosen at start
		// once the client knows whether this socket's server grants credits.
		const streamId = _nextUploadStreamId();
		const total = _uploadSourceTotal(source);
		return new UploadHandle(path, source, args, { streamId, total });
	};
}
