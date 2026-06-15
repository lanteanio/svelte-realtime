// @ts-check
import { connect as _connect, on } from 'svelte-adapter-uws/client';
import { now, setTimer, microtask } from '../client-runtime.js';
import { clientState, RpcError, _textEncoder, _isDev, pendingUploads } from './internal-state.js';
import { ensureDisconnectListener } from './connection.js';

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
//                [12..12+argsLen-1] argsJson UTF-8: { rpc, args? }
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
// either { ok: true, data } or { ok: false, code, error }.

/** Default wire-frame size in bytes when neither user-configured nor
 * server-discovered. Tuned to fit under `svelte-adapter-uws`'s old default
 * `maxPayloadLength` (16KB) with room for the frame header and args JSON.
 * Discovery via the server's `__cap` hint upgrades this automatically on
 * the first upload response (e.g. to 1MB under the adapter's 0.5.x default).
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

/** Server-discovered `platform.maxPayloadLength`. Updated whenever an upload
 * response arrives carrying `__cap`. 0 = not yet discovered. */
let _discoveredUploadMaxFrameSize = 0;

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
 *      used for the very first upload after page load, before discovery.
 *
 * Re-evaluated at every upload start so the SECOND upload picks up the
 * value discovered on the first.
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

	const discoveredCap = _discoveredUploadMaxFrameSize > 0 ? _discoveredUploadMaxFrameSize : Infinity;

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

	if (_discoveredUploadMaxFrameSize > 0) return _discoveredUploadMaxFrameSize;
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
	_discoveredUploadMaxFrameSize = 0;
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
 * Async-iterate any supported source as `Uint8Array` chunks of `chunkSize`.
 * Last chunk may be smaller than `chunkSize`. Empty sources yield nothing.
 *
 * Supported: `Blob` / `File`, `ArrayBuffer`, any `ArrayBufferView`,
 * `ReadableStream<Uint8Array>`. Throws `TypeError` for anything else.
 *
 * @param {any} source
 * @param {number} chunkSize
 * @returns {AsyncIterable<Uint8Array>}
 */
async function* _chunkUploadSource(source, chunkSize) {
	if (typeof Blob !== 'undefined' && source instanceof Blob) {
		let offset = 0;
		while (offset < source.size) {
			const slice = source.slice(offset, offset + chunkSize);
			yield new Uint8Array(await slice.arrayBuffer());
			offset += chunkSize;
		}
		return;
	}
	if (source instanceof ArrayBuffer) {
		const view = new Uint8Array(source);
		let offset = 0;
		while (offset < view.byteLength) {
			yield view.subarray(offset, Math.min(offset + chunkSize, view.byteLength));
			offset += chunkSize;
		}
		return;
	}
	if (ArrayBuffer.isView(source)) {
		const u8 = source instanceof Uint8Array
			? source
			: new Uint8Array(/** @type {any} */ (source).buffer, /** @type {any} */ (source).byteOffset, /** @type {any} */ (source).byteLength);
		let offset = 0;
		while (offset < u8.byteLength) {
			yield u8.subarray(offset, Math.min(offset + chunkSize, u8.byteLength));
			offset += chunkSize;
		}
		return;
	}
	if (typeof ReadableStream !== 'undefined' && source instanceof ReadableStream) {
		yield* _chunkReadableStream(source, chunkSize);
		return;
	}
	throw new TypeError('Unsupported upload source: expected Blob, File, ArrayBuffer, ArrayBufferView, or ReadableStream');
}

/**
 * Re-chunk a `ReadableStream<Uint8Array>` to fixed-size chunks. Buffers
 * across reads so the producer's chunk boundaries don't matter.
 * @param {ReadableStream<any>} stream
 * @param {number} chunkSize
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* _chunkReadableStream(stream, chunkSize) {
	const reader = stream.getReader();
	/** @type {Uint8Array[]} */
	const pending = [];
	let pendingBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) {
				throw new TypeError('ReadableStream must yield Uint8Array');
			}
			if (value.byteLength === 0) continue;
			pending.push(value);
			pendingBytes += value.byteLength;

			while (pendingBytes >= chunkSize) {
				const out = new Uint8Array(chunkSize);
				let written = 0;
				while (written < chunkSize) {
					const head = pending[0];
					const remaining = chunkSize - written;
					if (head.byteLength <= remaining) {
						out.set(head, written);
						written += head.byteLength;
						pending.shift();
					} else {
						out.set(head.subarray(0, remaining), written);
						pending[0] = head.subarray(remaining);
						written += remaining;
					}
				}
				pendingBytes -= chunkSize;
				yield out;
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* already released */ }
	}

	if (pendingBytes > 0) {
		const out = new Uint8Array(pendingBytes);
		let written = 0;
		for (const buf of pending) {
			out.set(buf, written);
			written += buf.byteLength;
		}
		yield out;
	}
}

/**
 * Subscribe to the `__upload` topic exactly once. Routes incoming envelopes
 * to the matching pending handle by streamId.
 */
function ensureUploadListener() {
	if (uploadListenerAttached) return;
	uploadListenerAttached = true;

	const store = on('__upload');
	store.subscribe((envelope) => {
		if (!envelope) return;
		// Always update the auto-discovered cap, even for envelopes that
		// don't match a pending handle (late responses after cancel still
		// teach us the server's frame-size cap).
		const data = envelope.data;
		if (data && typeof data.__cap === 'number' && data.__cap > 0) {
			_discoveredUploadMaxFrameSize = data.__cap;
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
	const argsJson = handle._argsJson;
	const conn = _connect();

	const iter = _chunkUploadSource(handle._source, handle._chunkSize)[Symbol.asyncIterator]();

	let cur = await iter.next();
	if (handle._cancelled || handle._settled) return;

	if (cur.done) {
		// Empty upload: chunk 0 with isLast=true and no payload, hasArgs=true.
		_sendUploadChunk(conn, handle, 0, true, true, argsJson, null);
		return;
	}

	let next = await iter.next();
	let seq = 0;
	while (!handle._cancelled && !handle._settled) {
		const isLast = next.done;
		const hasArgs = seq === 0;
		const payload = cur.value;

		_sendUploadChunk(conn, handle, seq, isLast, hasArgs, hasArgs ? argsJson : null, payload);
		handle._trackProgress(payload.byteLength);

		if (isLast) return;

		// Pace against the WS send queue. With svelte-adapter-uws/client next.19+
		// `conn.bufferedAmount` reflects the underlying browser WebSocket's
		// `bufferedAmount`. If undefined (older adapter), this is a no-op and
		// chunks are queued unbounded (the previous behaviour).
		await _maybePaceUpload(handle, conn);

		cur = next;
		next = await iter.next();
		seq++;
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
 *   - `DISCONNECTED`         - WS closed mid-upload
 *   - `CONNECTION_CLOSED`    - WS terminated before start
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
	 * @param {{ chunkSize: number, streamId: number, total: number | undefined, argsJson: string }} options
	 */
	constructor(path, source, args, options) {
		this._path = path;
		this._source = source;
		this._args = args;
		this._chunkSize = options.chunkSize;
		this._streamId = options.streamId;
		this._total = options.total;
		this._argsJson = options.argsJson;
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
		try {
			const conn = _connect();
			conn.sendQueued(_encodeUploadCancelFrame(this._streamId));
		} catch { /* connection may be closed; server will discard the upload */ }
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

	_settle(ok, payload) {
		if (this._settled) return;
		this._settled = true;
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

	/** @param {{ ok?: boolean, data?: any, code?: string, error?: string, __cap?: number }} envelope */
	_onServerResponse(envelope) {
		// Auto-discover server's frame-size cap, regardless of settled state
		// so late responses still update the cache for future uploads.
		if (envelope && typeof envelope.__cap === 'number' && envelope.__cap > 0) {
			_discoveredUploadMaxFrameSize = envelope.__cap;
		}
		if (this._settled) return;
		if (envelope && envelope.ok) {
			this._settle(true, envelope.data);
		} else if (envelope) {
			const err = new RpcError(envelope.code || 'UNKNOWN', envelope.error || 'Upload failed');
			this._settle(false, err);
		}
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
		if (clientState.terminated) {
			this._settle(false, new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
			return;
		}

		ensureUploadListener();
		ensureDisconnectListener();

		try {
			await _pumpUpload(this);
		} catch (err) {
			if (this._settled) return;
			// Pump errored without a server response - typically a source-iter
			// failure (fs read, ReadableStream throw). Send a cancel so the
			// server doesn't keep waiting for chunks that won't arrive.
			if (!this._cancelled) {
				try {
					const conn = _connect();
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
		// Pre-compute args JSON + argsLen so the chunk-0 envelope overhead
		// is known statically for the whole upload. This lets us guarantee
		// every wire frame fits inside the adapter's maxPayloadLength cap.
		const argsJson = JSON.stringify({
			rpc: path,
			args: args.length > 0 ? args : undefined
		});
		const argsLen = _textEncoder.encode(argsJson).length;
		const frameSize = _computeUploadFrameSize();
		const chunkSize = _payloadSizeForFrame(frameSize, argsLen);
		const streamId = _nextUploadStreamId();
		const total = _uploadSourceTotal(source);
		return new UploadHandle(path, source, args, { chunkSize, streamId, total, argsJson });
	};
}
